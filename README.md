# Optical Pulse Monitor

A real-time optical pulse monitoring system built with a Raspberry Pi Pico WH and a React-based dashboard. The project uses an optical sensor circuit to collect pulse-related signals, processes the incoming ADC readings, and displays sensor information through a live web interface.

Developed as part of **CrownHacks**.

## Features

- **Real-Time Sensor Monitoring:** Receives live ADC readings from the Raspberry Pi Pico.
- **Live Dashboard:** Displays sensor information through an interactive React interface.
- **Signal Quality Monitoring:** Classifies signal quality using the existing signal-processing logic.
- **Heart Rate Monitoring:** Processes the optical sensor signal to estimate beats per minute (BPM).
- **Live Sensor Status:** Displays connection status, ADC readings, signal quality, finger detection, and sampling status.
- **CSV Logging:** Records sensor readings and computed metrics for later analysis.
- **Hardware Integration:** Communicates with the Raspberry Pi Pico through Web Serial.

## Technologies Used

### Software
- React
- JavaScript
- Vite
- Tailwind CSS
- Lucide React
- MicroPython
- Web Serial API

### Hardware
- Raspberry Pi Pico WH
- IR emitter and optical detector
- MCP6004 quad operational amplifier
- Resistors and capacitors
- Breadboard and jumper wires

## Project Structure

```text
HeartApp/
│
├── pico/
│   └── main.py              # Raspberry Pi Pico MicroPython code
│
├── public/
│
├── src/
│   ├── App.jsx
│   ├── Pulse.jsx            # Main monitoring dashboard
│   ├── main.jsx
│   └── index.css
│
├── index.html
├── package.json
├── package-lock.json
└── vite.config.js
```

##  Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/SuleKalkan/CrownHacks.git
```

Navigate into the project folder:

```bash
cd CrownHacks/HeartApp
```

### 2. Install Dependencies

Make sure you have Node.js and npm installed.

Run:

```bash
npm install
```

### 3. Start the Development Server

```bash
npm run dev
```

Open the localhost URL displayed in your terminal, usually:

```text
http://localhost:5173/
```

**Note:** The dashboard runs locally in your browser.

## Raspberry Pi Pico Setup

The Raspberry Pi Pico WH runs MicroPython and sends raw ADC readings to the dashboard through USB serial communication.

### 1. Install Thonny

Download and install [Thonny](https://thonny.org/).

### 2. Connect the Pico

- Connect the Raspberry Pi Pico WH to your computer through USB.
- Open Thonny.
- Select the Raspberry Pi Pico interpreter.
- Open `pico/main.py`.

### 3. Upload the MicroPython Script

Save the script directly onto the Raspberry Pi Pico as:

```text
main.py
```

The script should continuously read the optical sensor through GP26 (ADC0) and print the readings.

Example:

```python
from machine import ADC
import time

sensor = ADC(26)

while True:
    reading = sensor.read_u16()
    print(reading)
    time.sleep_ms(10)
```

Saving the script as `main.py` on the Pico allows it to run automatically when the board starts.

## Connecting the Dashboard to the Pico

1. Connect the Raspberry Pi Pico to your computer.
2. Make sure the MicroPython script is running.
3. Close Thonny's serial connection before connecting through the browser.
4. Open the dashboard in Google Chrome or Microsoft Edge.
5. Use the dashboard's hardware connection control.
6. Select the Raspberry Pi Pico's serial port.
7. Once connected, the dashboard can begin receiving live sensor readings.

**Important:** The Web Serial API requires a compatible browser, such as Chrome or Edge, and a secure context such as localhost.

## Sensor Monitoring

The dashboard provides information including:

| Metric | Description |
|---|---|
| ADC Reading | Raw 16-bit sensor value received from the Pico |
| BPM | Estimated beats per minute |
| Signal Quality | Classification of the incoming optical signal |
| Finger Detection | Indicates whether a usable finger signal is detected |
| Connection Status | Indicates whether the Pico is connected |
| Sampling Status | Indicates whether sensor readings are being received |

## Testing and Calibration

The system can be tested by comparing its readings against a commercial fingertip pulse oximeter.

Testing can include:

- Comparing estimated BPM values.
- Observing changes in raw ADC readings.
- Evaluating signal quality.
- Checking sensor response and connection stability.
- Recording readings and metrics through CSV logging.

## Limitations

- Sensor readings depend on proper hardware assembly and finger placement.
- Movement and ambient light can affect optical measurements.
- BPM estimates require validation and calibration.
- The system is a hackathon prototype and is not intended for medical diagnosis or clinical use.
- Respiration and other derived metrics should be treated as experimental unless independently validated.

## Contributors

Developed collaboratively as a CrownHacks project.

---

**Built with using React, MicroPython, and Raspberry Pi Pico WH.**
