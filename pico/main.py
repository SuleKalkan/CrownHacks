"""
pulse_reader.py
Heartbeat (PPG) reader for Raspberry Pi Pico W.

Serial output format:
pulse,bpm,rep,need

Example:
31,85,52,40
"""

from machine import ADC, Pin
import time

# ------------------------------------------------------------------
# SETTINGS

PIN = 26
MAINS_HZ = 60
MAINS_CYCLES = 2
SAMPLE_RATE_HZ = 25

DISPLAY_GAIN = None
DISPLAY_LIMIT = 60

SLOW_SPEED = 0.12
SMOOTH_SPEED = 0.6

JUMP_COUNTS = 40
JUMP_FRACTION = 0.15

ARTIFACT_COUNTS = 8
ARTIFACT_FRACTION = 0.01

HOLDOFF_SECONDS = 1.0
WINDOW_SECONDS = 8

MIN_BPM = 45
MAX_BPM = 180

MIN_WAVE_COUNTS = 0.1
MIN_REPEAT = 0.4

STALE_SECONDS = 3
LAGS_PER_SAMPLE = 2


# ------------------------------------------------------------------
# SIGNAL READING

def average_reads(adc, window_us):
    total = adc.read_u16()
    count = 1

    start = time.ticks_us()

    while time.ticks_diff(time.ticks_us(), start) < window_us:
        total += adc.read_u16()
        count += 1

    return total / count


# ------------------------------------------------------------------
# PULSE FILTER

class BeatWave:

    def __init__(self):
        self.slow1 = None
        self.slow2 = 0.0
        self.smooth = 0.0
        self.restarted = False
        self.artifact = ARTIFACT_COUNTS

    def update(self, level):

        jump = max(
            JUMP_COUNTS,
            JUMP_FRACTION * (self.slow1 or 0.0)
        )

        self.restarted = (
            self.slow1 is None
            or abs(level - self.slow1) > jump
        )

        if self.restarted:
            self.slow1 = level
            self.slow2 = 0.0
            self.smooth = 0.0

            self.artifact = max(
                ARTIFACT_COUNTS,
                ARTIFACT_FRACTION * level
            )

            return 0.0

        self.slow1 += (
            (level - self.slow1) * SLOW_SPEED
        )

        self.artifact = max(
            ARTIFACT_COUNTS,
            ARTIFACT_FRACTION * self.slow1
        )

        wave = level - self.slow1

        self.slow2 += (
            (wave - self.slow2) * SLOW_SPEED
        )

        wave -= self.slow2

        self.smooth += (
            (wave - self.smooth) * SMOOTH_SPEED
        )

        return self.smooth


# ------------------------------------------------------------------
# GRAPH SCALING

class PlotScale:

    TARGET = 20.0
    MAX_GAIN = 400.0

    def __init__(self):
        self.size = 0.0
        self.count = 0

    def gain(self, wave):

        mag = abs(wave)
        self.count += 1

        if self.size > 0.0:
            mag = min(mag, 3 * self.size)

        self.size += (
            (mag - self.size)
            * max(0.01, 1.0 / self.count)
        )

        return min(
            self.MAX_GAIN,
            self.TARGET / max(self.size, 0.02)
        )


# ------------------------------------------------------------------
# HEARTBEAT CALCULATION

class BeatCounter:

    def __init__(self):
        self.holdoff = 0
        self.reset()

    def reset(self):

        self.waves = []
        self.stamps = []

        self.bpm = 0
        self.rep = 0.0
        self.stale = 0

        self.snapshot = None

    def update(self, wave, now_ms, restarted=False,
               limit=ARTIFACT_COUNTS):

        if restarted or abs(wave) > limit:

            self.reset()

            self.holdoff = int(
                HOLDOFF_SECONDS * SAMPLE_RATE_HZ
            )

            return 0

        if self.holdoff > 0:
            self.holdoff -= 1
            return 0

        self.waves.append(wave)
        self.stamps.append(now_ms)

        if len(self.waves) > WINDOW_SECONDS * SAMPLE_RATE_HZ:

            self.waves.pop(0)
            self.stamps.pop(0)

        if len(self.waves) >= (
            0.7 * WINDOW_SECONDS * SAMPLE_RATE_HZ
        ):
            self._measure()

        self.stale += 1

        if self.stale > STALE_SECONDS * SAMPLE_RATE_HZ:
            self.bpm = 0

        return self.bpm

    def _measure(self):

        if self.snapshot is None:

            n = len(self.waves)

            mean = sum(self.waves) / n

            self.snapshot = [
                w - mean for w in self.waves
            ]

            self.power = (
                sum(w * w for w in self.snapshot) / n
            )

            self.period_ms = (
                self.stamps[-1] - self.stamps[0]
            ) / (n - 1)

            self.first_lag = int(
                60000 / (MAX_BPM * self.period_ms)
            )

            self.last_lag = int(
                60000 / (MIN_BPM * self.period_ms)
            ) + 1

            self.lag = self.first_lag - 1
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

            self.matches[lag] = (
                total / (n - lag) / self.power
                if self.power else 0.0
            )

            lag += 1

        self.lag = lag

        if lag > self.last_lag + 1:

            self._finish()
            self.snapshot = None

    def _finish(self):

        self.rep = 0.0
        m = self.matches

        peaks = [
            lag
            for lag in range(
                self.first_lag,
                self.last_lag + 1
            )
            if m[lag - 1] < m[lag] >= m[lag + 1]
        ]

        if not peaks:
            return

        best = max(m[lag] for lag in peaks)
        self.rep = best

        if self.power < MIN_WAVE_COUNTS ** 2:
            return

        if best < MIN_REPEAT:
            return

        lag = min(
            p for p in peaks
            if m[p] >= 0.8 * best
        )

        below = m[lag - 1]
        above = m[lag + 1]

        curve = below - 2 * m[lag] + above

        exact = lag + (
            0.5 * (below - above) / curve
            if curve else 0.0
        )

        bpm = int(
            60000 / (exact * self.period_ms) + 0.5
        )

        if MIN_BPM <= bpm <= MAX_BPM:

            self.bpm = bpm
            self.stale = 0


# ------------------------------------------------------------------
# MAIN PROGRAM

def main():

    adc = ADC(Pin(PIN))

    try:
        Pin("WL_GPIO1", Pin.OUT, value=1)
    except Exception:
        pass

    window_us = (
        MAINS_CYCLES * 1000000 // MAINS_HZ
    )

    period_us = 1000000 // SAMPLE_RATE_HZ

    wave_filter = BeatWave()
    counter = BeatCounter()
    scale = PlotScale()

    start_ms = time.ticks_ms()
    next_tick = time.ticks_us()

    try:

        while True:

            # Read and filter sensor
            wave = wave_filter.update(
                average_reads(adc, window_us)
            )

            # Calculate BPM
            bpm = counter.update(
                wave,
                time.ticks_diff(
                    time.ticks_ms(),
                    start_ms
                ),
                wave_filter.restarted,
                wave_filter.artifact
            )

            # Scale waveform for dashboard
            gain = DISPLAY_GAIN or scale.gain(wave)

            shown = max(
                -DISPLAY_LIMIT,
                min(DISPLAY_LIMIT, wave * gain)
            )

            # --------------------------------------------------
            # WEBSITE SERIAL OUTPUT
            # Format: pulse,bpm,rep,need
            # --------------------------------------------------

            pulse_value = round(shown)
            bpm_value = bpm

            repeat_quality = round(
                max(0.0, counter.rep) * 100
            )

            required_quality = round(
                MIN_REPEAT * 100
            )

            print(
                str(pulse_value) + "," +
                str(bpm_value) + "," +
                str(repeat_quality) + "," +
                str(required_quality)
            )

            # Maintain sample rate
            next_tick = time.ticks_add(
                next_tick,
                period_us
            )

            wait_us = time.ticks_diff(
                next_tick,
                time.ticks_us()
            )

            if wait_us > 0:
                time.sleep_us(wait_us)
            else:
                next_tick = time.ticks_us()

    except KeyboardInterrupt:
        print("stopped")


if __name__ == "__main__":
    main()