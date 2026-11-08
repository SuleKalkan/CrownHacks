from machine import ADC, Pin
import time


amp_adc = ADC(Pin(27))  # Pin 32 (Wire O - Amplified Output)


# 100 Hz sampling (every 10 ms) for a fast, smooth monitor line
SAMPLE_INTERVAL_MS = 10


filtered_sig = 32768.0
adaptive_thresh = 32768.0
ALPHA_FILTER = 0.20      # Smooths high-frequency electrical fuzz
ALPHA_THRESH = 0.03      # Tracks slow finger pressure changes
THRESHOLD_MARGIN = 350   # Sensitivity margin above baseline


MIN_BEAT_INTERVAL_MS = 350
last_beat_time = time.ticks_ms()
prev_filtered = filtered_sig


# Wait briefly before printing anything so the Plotter only sees tuple numbers
time.sleep(1)


while True:
    loop_start = time.ticks_ms()
    raw_amp = amp_adc.read_u16()
   
    # 1. Smooth signal and update baseline threshold
    filtered_sig = (ALPHA_FILTER * raw_amp) + ((1.0 - ALPHA_FILTER) * filtered_sig)
    adaptive_thresh = (ALPHA_THRESH * filtered_sig) + ((1.0 - ALPHA_THRESH) * adaptive_thresh)
    trigger_level = adaptive_thresh + THRESHOLD_MARGIN
   
    # 2. Check for heartbeat peak to create a visual spike marker
    now = time.ticks_ms()
    time_delta = time.ticks_diff(now, last_beat_time)
    beat_marker = int(adaptive_thresh)  # Stays flat on the baseline between beats
   
    if prev_filtered <= trigger_level and filtered_sig > trigger_level:
        if time_delta > MIN_BEAT_INTERVAL_MS:
            last_beat_time = now
            beat_marker = int(filtered_sig + 800)  # Spikes upward on each beat!
           
    prev_filtered = filtered_sig
   
    # 3. Print ONLY similar-scale values so the Plotter zooms in on the wave:
    # (Pulse Wave, Trigger Threshold, Beat Spike Marker)
    print((int(filtered_sig), int(trigger_level), beat_marker))
   
    elapsed = time.ticks_diff(time.ticks_ms(), loop_start)
    if SAMPLE_INTERVAL_MS - elapsed > 0:
        time.sleep_ms(SAMPLE_INTERVAL_MS - elapsed)
