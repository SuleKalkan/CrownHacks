"""
pulse_reader.py - heartbeat (PPG) reader for the Raspberry Pi Pico W (MicroPython)

Hardware
    GP26 (ADC0)  raw  signal straight from the IR detector   (used by default)
    GP27 (ADC1)  amp  the same signal after the MCP6004 stage (set PIN = 27)

What it does
    1. Each sample is the average of hundreds of ADC reads taken over whole
       mains cycles. That cancels 50/60 Hz hum and cuts random noise.
    2. A band-pass filter keeps only the 0.5 - 4 Hz range where heartbeats
       live. The slow drift of a settling fingertip disappears.
    3. It measures how often the wave repeats (autocorrelation over the last
       8 seconds) and turns that into beats per minute. This works even when
       each heartbeat has more than one bump.

Output
    SAMPLE_RATE_HZ lines per second, for example:

        pulse 31  bpm 85  rep 52  need 40

    pulse  the wave, scaled so a typical swing is about 20 tall (see DISPLAY_GAIN)
    bpm    heart rate; 0 means "no reading" (it needs about 8 seconds of steady
           signal, and goes back to 0 when the finger moves or lifts)
    rep    how strongly the wave repeats itself, 0 to 100. A real pulse pushes it up.
    need   the line 'rep' has to be above before a BPM is shown (MIN_REPEAT)

    Watch 'rep' while you move the finger or change the pressure: the placement
    that gets it above 'need' and keeps it there is the one that works.
    Set SHOW_DEBUG = False to print only 'pulse' and 'bpm'.

    The plot is clamped to +-DISPLAY_LIMIT because Thonny's Plotter never shrinks
    its range on its own: one big spike from touching the sensor would flatten
    everything after it.

Usage
    In Thonny, pick the "MicroPython (Raspberry Pi Pico)" interpreter, press
    Run and open View > Plotter. Rest a fingertip on the sensor with light,
    steady pressure and hold still. Press Stop to end.
"""
from machine import ADC, Pin
import time

# ------------------------------------------------------------------ settings
PIN = 26                  # 26 = raw detector, 27 = after the amplifier
MAINS_HZ = 60             # 60 in the US, 50 in most other countries
MAINS_CYCLES = 2          # each sample averages this many whole mains cycles (1 or 2).
                          # More is quieter. If the Plotter ever lags, set 1.
SAMPLE_RATE_HZ = 25       # printed samples per second

DISPLAY_GAIN = None       # None = automatic: a typical swing is drawn about 20 tall.
                          # Or a number (plot units per ADC count) to fix the scale.
DISPLAY_LIMIT = 60        # the plot never goes beyond +- this
SHOW_DEBUG = True         # also print 'rep' and 'need'; False = only 'pulse' and 'bpm'

SLOW_SPEED = 0.12         # high-pass strength: bigger removes slower drift less
SMOOTH_SPEED = 0.6        # low-pass: 1.0 = no smoothing, smaller = smoother
JUMP_COUNTS = 40          # a sudden change this big (finger on/off) restarts the filter...
JUMP_FRACTION = 0.15      # ...or this fraction of the light level, whichever is bigger

ARTIFACT_COUNTS = 8       # a wave bigger than this is movement, not a heartbeat...
ARTIFACT_FRACTION = 0.01  # ...or this fraction of the light level, whichever is bigger
                          # (a real pulse is typically well under 1% of the level, rms)
HOLDOFF_SECONDS = 1.0     # ignore the wave for this long after movement
WINDOW_SECONDS = 8        # BPM is measured over the most recent this-many seconds
MIN_BPM = 45              # slowest and fastest heart rates it will report
MAX_BPM = 180
MIN_WAVE_COUNTS = 0.1     # the wave must be at least this big (rms, ADC counts)
MIN_REPEAT = 0.4          # how closely the wave must repeat itself (0 to 1). Lower shows
                          # BPM on weaker signals but wrong readings appear more often
STALE_SECONDS = 3         # BPM goes back to 0 if it can't be confirmed for this long
LAGS_PER_SAMPLE = 2       # BPM work done per sample (keeps the sampling steady)


# ------------------------------------------------------------------- signals
def average_reads(adc, window_us):
    """Average ADC reads (0..65535) taken back to back for window_us microseconds."""
    total = adc.read_u16()
    count = 1
    start = time.ticks_us()
    while time.ticks_diff(time.ticks_us(), start) < window_us:
        total += adc.read_u16()
        count += 1
    return total / count


class BeatWave:
    """Band-pass filter: turns light levels into a zero-centred wave."""

    def __init__(self):
        self.slow1 = None          # slow estimate of the steady light level
        self.slow2 = 0.0           # second high-pass stage (also removes steady drift)
        self.smooth = 0.0          # low-pass stage
        self.restarted = False     # True when the last sample restarted the filter
        self.artifact = ARTIFACT_COUNTS    # waves bigger than this count as movement

    def update(self, level):
        """Feed one light level; returns the wave in ADC counts."""
        jump = max(JUMP_COUNTS, JUMP_FRACTION * (self.slow1 or 0.0))
        self.restarted = self.slow1 is None or abs(level - self.slow1) > jump
        if self.restarted:                         # first sample, or finger on/off
            self.slow1, self.slow2, self.smooth = level, 0.0, 0.0
            self.artifact = max(ARTIFACT_COUNTS, ARTIFACT_FRACTION * level)
            return 0.0
        self.slow1 += (level - self.slow1) * SLOW_SPEED
        self.artifact = max(ARTIFACT_COUNTS, ARTIFACT_FRACTION * self.slow1)
        wave = level - self.slow1
        self.slow2 += (wave - self.slow2) * SLOW_SPEED
        wave -= self.slow2
        self.smooth += (wave - self.smooth) * SMOOTH_SPEED
        return self.smooth


class PlotScale:
    """Chooses the plot scale so a typical swing is about 20 tall, weak signal or strong."""

    TARGET = 20.0
    MAX_GAIN = 400.0

    def __init__(self):
        self.size = 0.0            # typical size of the wave (average of |wave|), ADC counts
        self.count = 0

    def gain(self, wave):
        mag = abs(wave)
        self.count += 1
        if self.size > 0.0:
            mag = min(mag, 3 * self.size)          # one spike must not shrink the plot
        self.size += (mag - self.size) * max(0.01, 1.0 / self.count)   # fast at first, then ~4 s
        return min(self.MAX_GAIN, self.TARGET / max(self.size, 0.02))


class BeatCounter:
    """Measures the heart rate from how often the wave repeats.

    Compares the last few seconds of the wave with copies of itself shifted
    by different delays. When the delay equals the time between heartbeats the
    two line up and the match is strong, so the best delay gives the BPM.
    The comparison is done a few delays per sample, so no sample is held up.
    """

    def __init__(self):
        self.holdoff = 0           # samples left to ignore after movement
        self.reset()

    def reset(self):
        self.waves = []            # recent wave, oldest first
        self.stamps = []           # time of each sample, ms
        self.bpm = 0
        self.rep = 0.0             # latest match strength, 0..1 (for display)
        self.stale = 0             # samples since the BPM was last confirmed
        self.snapshot = None       # the copy being measured

    def update(self, wave, now_ms, restarted=False, limit=ARTIFACT_COUNTS):
        """Feed one wave sample; returns the current BPM (0 = no reading)."""
        if restarted or abs(wave) > limit:              # finger on/off, or movement
            self.reset()
            self.holdoff = int(HOLDOFF_SECONDS * SAMPLE_RATE_HZ)
            return 0
        if self.holdoff > 0:
            self.holdoff -= 1
            return 0

        self.waves.append(wave)
        self.stamps.append(now_ms)
        if len(self.waves) > WINDOW_SECONDS * SAMPLE_RATE_HZ:
            self.waves.pop(0)
            self.stamps.pop(0)
        if len(self.waves) >= 0.7 * WINDOW_SECONDS * SAMPLE_RATE_HZ:
            self._measure()
        self.stale += 1
        if self.stale > STALE_SECONDS * SAMPLE_RATE_HZ:
            self.bpm = 0
        return self.bpm

    def _measure(self):
        """Do a little more of the repeat-matching; finish an estimate when done."""
        if self.snapshot is None:
            n = len(self.waves)
            mean = sum(self.waves) / n
            self.snapshot = [w - mean for w in self.waves]
            self.power = sum(w * w for w in self.snapshot) / n
            self.period_ms = (self.stamps[-1] - self.stamps[0]) / (n - 1)
            self.first_lag = int(60000 / (MAX_BPM * self.period_ms))
            self.last_lag = int(60000 / (MIN_BPM * self.period_ms)) + 1
            self.lag = self.first_lag - 1                  # one extra each side, for the peak fit
            self.matches = {}
        data = self.snapshot
        n = len(data)
        lag = self.lag
        for _ in range(LAGS_PER_SAMPLE):
            if lag > self.last_lag + 1:
                break
            total = 0.0
            for i in range(n - lag):
                total += data[i] * data[i + lag]
            # match strength 0..1, corrected for the shorter overlap at long delays
            self.matches[lag] = total / (n - lag) / self.power if self.power else 0.0
            lag += 1
        self.lag = lag
        if lag > self.last_lag + 1:
            self._finish()
            self.snapshot = None

    def _finish(self):
        self.rep = 0.0
        m = self.matches
        peaks = [lag for lag in range(self.first_lag, self.last_lag + 1)
                 if m[lag - 1] < m[lag] >= m[lag + 1]]
        if not peaks:
            return
        best = max(m[lag] for lag in peaks)
        self.rep = best
        if self.power < MIN_WAVE_COUNTS ** 2:
            return                                 # too quiet to be a pulse
        if best < MIN_REPEAT:
            return                                 # the wave isn't repeating: no pulse
        lag = min(p for p in peaks if m[p] >= 0.8 * best)    # shortest delay that matches well
        below, above = m[lag - 1], m[lag + 1]
        curve = below - 2 * m[lag] + above
        exact = lag + (0.5 * (below - above) / curve if curve else 0.0)
        bpm = int(60000 / (exact * self.period_ms) + 0.5)
        if MIN_BPM <= bpm <= MAX_BPM:
            self.bpm = bpm
            self.stale = 0


# ---------------------------------------------------------------------- main
def main():
    adc = ADC(Pin(PIN))
    try:
        # Pico W: run the on-board power supply in its low-ripple mode. Less supply
        # noise on the ADC. (Ignored on boards that don't have this pin.)
        Pin("WL_GPIO1", Pin.OUT, value=1)
    except Exception:
        pass

    window_us = MAINS_CYCLES * 1000000 // MAINS_HZ
    period_us = 1000000 // SAMPLE_RATE_HZ
    wave_filter = BeatWave()
    counter = BeatCounter()
    scale = PlotScale()

    start_ms = time.ticks_ms()
    next_tick = time.ticks_us()
    try:
        while True:
            wave = wave_filter.update(average_reads(adc, window_us))
            bpm = counter.update(wave, time.ticks_diff(time.ticks_ms(), start_ms),
                                 wave_filter.restarted, wave_filter.artifact)
            gain = DISPLAY_GAIN or scale.gain(wave)
            shown = max(-DISPLAY_LIMIT, min(DISPLAY_LIMIT, wave * gain))
            if SHOW_DEBUG:
                print("pulse", round(shown), " bpm", bpm,
                      " rep", round(max(0.0, counter.rep) * 100), " need", round(MIN_REPEAT * 100))
            else:
                print("pulse", round(shown), " bpm", bpm)

            # keep a steady sample rate
            next_tick = time.ticks_add(next_tick, period_us)
            wait_us = time.ticks_diff(next_tick, time.ticks_us())
            if wait_us > 0:
                time.sleep_us(wait_us)
            else:
                next_tick = time.ticks_us()    # fell behind, resynchronize
    except KeyboardInterrupt:
        print("stopped")


if __name__ == "__main__":
    main()