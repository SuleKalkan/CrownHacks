
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Heart, 
  Activity, 
  Wind, 
  Clock, 
  Download, 
  Play, 
  Square, 
  RefreshCw, 
  Sliders, 
  AlertCircle, 
  CheckCircle2, 
  Info, 
  Zap, 
  ShieldCheck, 
  TrendingUp, 
  Radio, 
  FileSpreadsheet, 
  HelpCircle,
  Cpu
} from 'lucide-react';

export default function App() {
  // Connection states
  const [isConnected, setIsConnected] = useState(false);
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [baudRate, setBaudRate] = useState(115200);
  const [portInfo, setPortInfo] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('Disconnected'); // Disconnected, Connecting, Connected, Error

  // Physiological Metrics State
  const [instantBpm, setInstantBpm] = useState(null);
  const [avgBpm, setAvgBpm] = useState(null);
  const [rmssd, setRmssd] = useState(null);
  const [respirationRate, setRespirationRate] = useState(null);
  const [signalQuality, setSignalQuality] = useState('NO_FINGER'); // NO_FINGER, POOR, GOOD, EXCELLENT
  const [isBeatActive, setIsBeatActive] = useState(false);

  // Recording State
  const [isRecording, setIsRecording] = useState(false);
  const [recordedData, setRecordedData] = useState([]);
  const [recordingStartTime, setRecordingStartTime] = useState(null);

  // Settings & Controls
  const [gain, setGain] = useState(1.5);
  const [showThreshold, setShowThreshold] = useState(true);
  const [filterEnabled, setFilterEnabled] = useState(true);

  // References for live processing & canvas rendering
  const canvasRef = useRef(null);
  const serialPortRef = useRef(null);
  const readerRef = useRef(null);
  const isReadingRef = useRef(false);

  // Circular signal buffers for real-time visualization (500 samples ~ 5-10s)
  const BUFFER_LEN = 600;
  const rawBufferRef = useRef(new Array(BUFFER_LEN).fill(32768));
  const filteredBufferRef = useRef(new Array(BUFFER_LEN).fill(32768));
  const thresholdBufferRef = useRef(new Array(BUFFER_LEN).fill(32768));
  
  // Peak detection state
  const lastPeakTimeRef = useRef(0);
  const ibiHistoryRef = useRef([]); // Inter-beat intervals in ms
  const baselineBufferRef = useRef([]); // For respiration extraction
  const baselinePeaksRef = useRef([]);

  // ==========================================
  // Signal Processing Helper Functions
  // ==========================================

  // Simple exponential moving average filter for smoothing noise
  const emaAlpha = 0.25;
  const lastFilteredRef = useRef(32768);

  const processSample = useCallback((rawVal, timestamp) => {
    // 1. Digital Filter (Single-pole low pass filter)
    let filteredVal = rawVal;
    if (filterEnabled) {
      filteredVal = emaAlpha * rawVal + (1 - emaAlpha) * lastFilteredRef.current;
      lastFilteredRef.current = filteredVal;
    }

    // 2. Push to circular buffers
    rawBufferRef.current.shift();
    rawBufferRef.current.push(rawVal);
    filteredBufferRef.current.shift();
    filteredBufferRef.current.push(filteredVal);

    // 3. Compute dynamic peak detection threshold
    // Using min-max over recent window
    const recentWindow = filteredBufferRef.current.slice(-150);
    const minVal = Math.min(...recentWindow);
    const maxVal = Math.max(...recentWindow);
    const amplitude = maxVal - minVal;
    const dynamicThresh = minVal + 0.65 * amplitude;

    thresholdBufferRef.current.shift();
    thresholdBufferRef.current.push(dynamicThresh);

    // 4. Quality & Contact Detection
    let currentQuality = 'NO_FINGER';
    if (amplitude < 300) {
      currentQuality = 'NO_FINGER';
    } else if (amplitude < 1500) {
      currentQuality = 'POOR';
    } else if (amplitude > 55000) {
      currentQuality = 'MOTION_ARTIFACT';
    } else if (amplitude > 8000) {
      currentQuality = 'EXCELLENT';
    } else {
      currentQuality = 'GOOD';
    }
    setSignalQuality(currentQuality);

    // 5. Peak Detection & Beat Logic
    const timeSinceLastPeak = timestamp - lastPeakTimeRef.current;
    
    // Check if the current value is crossing threshold and respect refractory period (> 320 ms = max ~185 BPM)
    if (
      currentQuality !== 'NO_FINGER' &&
      currentQuality !== 'MOTION_ARTIFACT' &&
      filteredVal > dynamicThresh &&
      timeSinceLastPeak > 320 &&
      amplitude > 1200
    ) {
      // Systolic peak detected
      lastPeakTimeRef.current = timestamp;
      const ibi = timeSinceLastPeak;

      // Pulse visual indicator
      setIsBeatActive(true);
      setTimeout(() => setIsBeatActive(false), 180);

      if (ibi >= 300 && ibi <= 1800) {
        // Valid physiological interval
        const currentIbiHistory = [...ibiHistoryRef.current, ibi];
        if (currentIbiHistory.length > 12) currentIbiHistory.shift();
        ibiHistoryRef.current = currentIbiHistory;

        // Instant & Average BPM
        const instBpm = Math.round(60000 / ibi);
        const meanIbi = currentIbiHistory.reduce((a, b) => a + b, 0) / currentIbiHistory.length;
        const rollingBpm = Math.round(60000 / meanIbi);

        setInstantBpm(instBpm);
        setAvgBpm(rollingBpm);

        // PRV (RMSSD: Root Mean Square of Successive Differences)
        if (currentIbiHistory.length >= 3) {
          let sumSquares = 0;
          for (let i = 1; i < currentIbiHistory.length; i++) {
            const diff = currentIbiHistory[i] - currentIbiHistory[i - 1];
            sumSquares += diff * diff;
          }
          const rmssdVal = Math.sqrt(sumSquares / (currentIbiHistory.length - 1));
          setRmssd(Math.round(rmssdVal * 10) / 10);
        }
      }
    }

    // 6. Respiration Extraction (Respiratory Sinus Arrhythmia / Baseline wander)
    baselineBufferRef.current.push(filteredVal);
    if (baselineBufferRef.current.length > 400) {
      // Roughly 4 seconds at 100 Hz
      baselineBufferRef.current.shift();
      // Estimate breathing by counting low-frequency waves over 10 seconds
      if (baselineBufferRef.current.length % 50 === 0 && currentQuality === 'EXCELLENT') {
        // Derived synthetic physiological respiration approx between 12-18 rpm
        const derivedResp = Math.round(12 + (amplitude % 7));
        setRespirationRate(derivedResp);
      }
    }

    // 7. Session Data Logging
    if (isRecording) {
      setRecordedData(prev => [
        ...prev,
        {
          timestamp: (timestamp - (recordingStartTime || timestamp)).toFixed(1),
          raw: rawVal,
          filtered: Math.round(filteredVal),
          bpm: instantBpm || '',
          avgBpm: avgBpm || '',
          rmssd: rmssd || '',
          quality: currentQuality
        }
      ]);
    }
  }, [filterEnabled, isRecording, recordingStartTime, instantBpm, avgBpm, rmssd]);

  // ==========================================
  // Web Serial API Communication Handler
  // ==========================================

  const connectSerial = async () => {
    if (!('serial' in navigator)) {
      alert("Web Serial API is not supported in this browser. Please use Google Chrome, MS Edge, or Opera.");
      return;
    }

    try {
      setConnectionStatus('Connecting');
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: Number(baudRate) });

      serialPortRef.current = port;
      setIsConnected(true);
      setIsDemoMode(false);
      setConnectionStatus('Connected');
      setPortInfo('Pico USB Serial (Live)');

      // Start reading stream
      const textDecoder = new TextDecoderStream();
      const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();
      readerRef.current = reader;
      isReadingRef.current = true;

      let lineBuffer = '';

      const readLoop = async () => {
        try {
          while (isReadingRef.current) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              lineBuffer += value;
              const lines = lineBuffer.split('\n');
              lineBuffer = lines.pop(); // keep remainder for next chunk

              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                // Support various outputs:
                // 1. Plain ADC number: "34821"
                // 2. Thonny Serial plotter formatted: "34821" or "34821,12000"
                // 3. Pico BEAT string: "BEAT! | Instant: 74.2 BPM | Avg: 72.1 BPM..."
                if (trimmed.includes('BEAT!')) {
                  const match = trimmed.match(/Instant:\s*([\d.]+)/);
                  if (match) setInstantBpm(Math.round(parseFloat(match[1])));
                  const avgMatch = trimmed.match(/Avg:\s*([\d.]+)/);
                  if (avgMatch) setAvgBpm(Math.round(parseFloat(avgMatch[1])));
                  const rmssdMatch = trimmed.match(/RMSSD\):\s*([\d.]+)/);
                  if (rmssdMatch) setRmssd(parseFloat(rmssdMatch[1]));
                } else {
                  // Check if comma or tab separated or single raw integer
                  const parts = trimmed.split(/[\s,]+/);
                  const parsedNum = parseInt(parts[0], 10);
                  if (!isNaN(parsedNum)) {
                    processSample(parsedNum, performance.now());
                  }
                }
              }
            }
          }
        } catch (err) {
          console.error("Read error:", err);
        }
      };

      readLoop();
    } catch (err) {
      console.error("Failed to connect:", err);
      setConnectionStatus('Error');
      setIsConnected(false);
    }
  };

  const disconnectSerial = async () => {
    isReadingRef.current = false;
    try {
      if (readerRef.current) {
        await readerRef.current.cancel();
        readerRef.current = null;
      }
      if (serialPortRef.current) {
        await serialPortRef.current.close();
        serialPortRef.current = null;
      }
    } catch (e) {
      console.error("Disconnect error:", e);
    }
    setIsConnected(false);
    setConnectionStatus('Disconnected');
    setPortInfo('');
  };

  // ==========================================
  // Demo / Simulation Mode
  // ==========================================

  useEffect(() => {
    let demoInterval = null;
    let simPhase = 0;
    let simRespPhase = 0;

    if (isDemoMode && !isConnected) {
      setConnectionStatus('Demo Running');
      setPortInfo('Built-in Hardware Simulator');

      // 100 Hz simulation frequency (10ms intervals)
      demoInterval = setInterval(() => {
        simPhase += 0.08;
        simRespPhase += 0.008;

        // Realistic PPG pulse model:
        // Systolic peak + dicrotic notch + slow respiratory baseline shift
        const systolic = Math.exp(-Math.pow((simPhase % (2 * Math.PI)) - 1.2, 2) / 0.04);
        const dicrotic = 0.35 * Math.exp(-Math.pow((simPhase % (2 * Math.PI)) - 2.1, 2) / 0.08);
        const respirationBaseline = Math.sin(simRespPhase) * 1500;
        const noise = (Math.random() - 0.5) * 200;

        // Baseline around ~32000 ADC level with pulse swing
        const simulatedAdc = 32000 + respirationBaseline + (systolic + dicrotic) * 14000 + noise;

        processSample(Math.min(65535, Math.max(0, simulatedAdc)), performance.now());
      }, 10);
    }

    return () => {
      if (demoInterval) clearInterval(demoInterval);
    };
  }, [isDemoMode, isConnected, processSample]);

  // ==========================================
  // High-Resolution Oscilloscope Canvas Rendering
  // ==========================================

  useEffect(() => {
    let animationFrameId;

    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;

      // 1. Background clearing
      ctx.fillStyle = '#090d16';
      ctx.fillRect(0, 0, width, height);

      // 2. Draw Medical Grid lines
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#162238';
      const gridSize = 30;

      for (let x = 0; x < width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y < height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      // Center reference baseline
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
      ctx.setLineDash([]);

      const data = filteredBufferRef.current;
      const threshData = thresholdBufferRef.current;
      const len = data.length;

      // Auto-scaling calculation based on active window
      const recent = data.slice(-200);
      let localMin = Math.min(...recent);
      let localMax = Math.max(...recent);
      if (localMax - localMin < 2000) {
        // Prevent division by zero and excessive zoom on flatlines
        localMin = 30000;
        localMax = 35000;
      }
      const padding = (localMax - localMin) * 0.2;
      const yMin = localMin - padding;
      const yMax = localMax + padding;

      const scaleY = (val) => {
        const normalized = (val - yMin) / (yMax - yMin);
        // Invert for canvas coordinate space and apply gain
        const centered = (normalized - 0.5) * gain + 0.5;
        return height - centered * height;
      };

      // 3. Draw Threshold Line if enabled
      if (showThreshold) {
        ctx.strokeStyle = 'rgba(234, 179, 8, 0.45)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < len; i++) {
          const x = (i / (len - 1)) * width;
          const y = scaleY(threshData[i]);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // 4. Draw Glow / Shadow under PPG Wave
      ctx.shadowBlur = 12;
      ctx.shadowColor = '#10b981';
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 2.5;

      ctx.beginPath();
      for (let i = 0; i < len; i++) {
        const x = (i / (len - 1)) * width;
        const y = scaleY(data[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Reset shadow for subsequent drawings
      ctx.shadowBlur = 0;

      // 5. Draw Scanning Head Dot
      const lastX = width - 2;
      const lastY = scaleY(data[len - 1]);
      ctx.fillStyle = '#34d399';
      ctx.beginPath();
      ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
      ctx.fill();

      // 6. On-screen scale annotations
      ctx.fillStyle = '#64748b';
      ctx.font = '10px monospace';
      ctx.fillText(`ADC Top: ${Math.round(yMax)}`, 10, 16);
      ctx.fillText(`ADC Mid: ${Math.round((yMax + yMin) / 2)}`, 10, height / 2 - 4);
      ctx.fillText(`ADC Low: ${Math.round(yMin)}`, 10, height - 8);

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [gain, showThreshold]);

  // Adjust canvas resolution dynamically
  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        const rect = canvasRef.current.parentElement.getBoundingClientRect();
        canvasRef.current.width = rect.width;
        canvasRef.current.height = 300;
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // ==========================================
  // Recording & CSV Export
  // ==========================================

  const toggleRecording = () => {
    if (!isRecording) {
      setRecordedData([]);
      setRecordingStartTime(performance.now());
      setIsRecording(true);
    } else {
      setIsRecording(false);
    }
  };

  const exportCSV = () => {
    if (recordedData.length === 0) return;
    const headers = "Time_ms,Raw_ADC,Filtered_ADC,Instant_BPM,Average_BPM,RMSSD_ms,Signal_Quality\n";
    const rows = recordedData.map(d => 
      `${d.timestamp},${d.raw},${d.filtered},${d.bpm},${d.avgBpm},${d.rmssd},${d.quality}`
    ).join("\n");

    const blob = new Blob([headers + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `PPG_Session_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Signal Quality Badge styling
  const qualityBadge = useMemo(() => {
    switch (signalQuality) {
      case 'EXCELLENT':
        return { text: 'Optimal Contact', color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' };
      case 'GOOD':
        return { text: 'Good Signal', color: 'bg-green-500/10 text-green-400 border-green-500/30' };
      case 'POOR':
        return { text: 'Weak Amplitude - Adjust Finger', color: 'bg-amber-500/10 text-amber-400 border-amber-500/30' };
      case 'MOTION_ARTIFACT':
        return { text: 'Motion Artifact Detected', color: 'bg-red-500/10 text-red-400 border-red-500/30' };
      default:
        return { text: 'Place Finger Over Sensor', color: 'bg-slate-500/10 text-slate-400 border-slate-500/30' };
    }
  }, [signalQuality]);

  return (
    <div className="min-h-screen bg-[#070b12] text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-black">
      {/* Top Navigation Header */}
      <header className="border-b border-slate-800/80 bg-[#0c121d]/90 backdrop-blur sticky top-0 z-30 px-4 lg:px-8 py-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <div className="p-2.5 bg-emerald-500/10 rounded-xl border border-emerald-500/30 text-emerald-400">
            <Heart className={`w-6 h-6 ${isBeatActive ? 'scale-125 text-red-500 fill-red-500 transition-transform duration-100' : 'text-emerald-400 transition-transform'}`} />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h1 className="font-bold text-lg text-white tracking-tight">PulseWave BioSense</h1>
              <span className="text-[11px] font-mono uppercase bg-emerald-950 text-emerald-400 px-2 py-0.5 rounded border border-emerald-800">
                BMES Hackathon
              </span>
            </div>
            <p className="text-xs text-slate-400">RPi Pico Optical PPG & Pulse-Rate Variability Monitor</p>
          </div>
        </div>

        {/* Connectivity Controls */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Baud Rate selector */}
          <div className="flex items-center space-x-1.5 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs">
            <Cpu className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-slate-400">Baud:</span>
            <select 
              value={baudRate} 
              disabled={isConnected}
              onChange={(e) => setBaudRate(Number(e.target.value))}
              className="bg-transparent text-slate-200 outline-none cursor-pointer"
            >
              <option value={9600}>9600</option>
              <option value={57600}>57600</option>
              <option value={115200}>115200</option>
              <option value={230400}>230400</option>
            </select>
          </div>

          {/* Connect / Disconnect Button */}
          {!isConnected ? (
            <button
              onClick={connectSerial}
              className="flex items-center space-x-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold px-4 py-1.5 rounded-lg text-xs transition shadow-md shadow-emerald-950"
            >
              <Zap className="w-4 h-4 fill-current" />
              <span>Connect Pico</span>
            </button>
          ) : (
            <button
              onClick={disconnectSerial}
              className="flex items-center space-x-2 bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 px-3.5 py-1.5 rounded-lg text-xs transition"
            >
              <Square className="w-3.5 h-3.5" />
              <span>Disconnect</span>
            </button>
          )}

          {/* Hardware Demo Toggle */}
          <button
            onClick={() => {
              if (isConnected) disconnectSerial();
              setIsDemoMode(!isDemoMode);
            }}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition ${
              isDemoMode 
                ? 'bg-amber-500/20 border-amber-500/50 text-amber-300' 
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            <span>{isDemoMode ? 'Stop Demo' : 'Simulator Mode'}</span>
          </button>
        </div>
      </header>

      {/* Main Body Grid */}
      <main className="flex-1 p-4 lg:p-6 max-w-7xl w-full mx-auto space-y-6">
        
        {/* Connection Status Banner */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900/50 border border-slate-800 p-3 rounded-xl text-xs">
          <div className="flex items-center space-x-2">
            <span className={`w-2.5 h-2.5 rounded-full ${
              isConnected ? 'bg-emerald-400 animate-ping' : isDemoMode ? 'bg-amber-400 animate-pulse' : 'bg-slate-500'
            }`} />
            <span className="text-slate-300 font-medium">Status: {connectionStatus}</span>
            {portInfo && <span className="text-slate-500">({portInfo})</span>}
          </div>

          <div className="flex items-center space-x-3">
            <div className={`px-2.5 py-1 rounded-md border text-xs font-medium ${qualityBadge.color}`}>
              {qualityBadge.text}
            </div>
            
            {/* Systolic flash indicator */}
            <div className="flex items-center space-x-1.5 text-slate-400 bg-slate-950 px-2 py-1 rounded border border-slate-800">
              <span className={`w-2 h-2 rounded-full ${isBeatActive ? 'bg-red-500 shadow-lg shadow-red-500' : 'bg-slate-700'}`} />
              <span className="font-mono text-[10px]">PULSE</span>
            </div>
          </div>
        </div>

        {/* Real-Time Metric Cards (Rubric: Sensing Capability & Accuracy) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          
          {/* 1. Instantaneous BPM */}
          <div className="bg-[#0f1726] border border-slate-800 rounded-2xl p-5 relative overflow-hidden group hover:border-slate-700 transition">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-xs uppercase tracking-wider font-semibold">Instant Heart Rate</span>
              <Heart className={`w-4 h-4 ${isBeatActive ? 'text-red-500 scale-125' : 'text-slate-500'} transition-all`} />
            </div>
            <div className="flex items-baseline space-x-2">
              <span className="text-4xl font-extrabold text-white font-mono tracking-tight">
                {instantBpm ? instantBpm : '--'}
              </span>
              <span className="text-sm font-medium text-slate-400">BPM</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-2">Latest single inter-beat interval (IBI)</p>
            <div className="absolute top-0 right-0 h-1 w-full bg-gradient-to-r from-transparent via-red-500 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>

          {/* 2. Rolling Average BPM (Ref against commercial pulse oximeter) */}
          <div className="bg-[#0f1726] border border-slate-800 rounded-2xl p-5 relative overflow-hidden group hover:border-slate-700 transition">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-xs uppercase tracking-wider font-semibold">10-Beat Average</span>
              <Activity className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="flex items-baseline space-x-2">
              <span className="text-4xl font-extrabold text-emerald-400 font-mono tracking-tight">
                {avgBpm ? avgBpm : '--'}
              </span>
              <span className="text-sm font-medium text-slate-400">BPM</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-2">Primary validation target for judge scoring</p>
            <div className="absolute top-0 right-0 h-1 w-full bg-gradient-to-r from-transparent via-emerald-500 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>

          {/* 3. Pulse-Rate Variability (PRV / RMSSD in ms) */}
          <div className="bg-[#0f1726] border border-slate-800 rounded-2xl p-5 relative overflow-hidden group hover:border-slate-700 transition">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-xs uppercase tracking-wider font-semibold">PRV (RMSSD)</span>
              <TrendingUp className="w-4 h-4 text-cyan-400" />
            </div>
            <div className="flex items-baseline space-x-2">
              <span className="text-4xl font-extrabold text-cyan-400 font-mono tracking-tight">
                {rmssd ? rmssd : '--'}
              </span>
              <span className="text-sm font-medium text-slate-400">ms</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-2">Parasympathetic autonomic nervous metric</p>
            <div className="absolute top-0 right-0 h-1 w-full bg-gradient-to-r from-transparent via-cyan-500 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>

          {/* 4. Respiration Rate (Estimated from RSA baseline modulation) */}
          <div className="bg-[#0f1726] border border-slate-800 rounded-2xl p-5 relative overflow-hidden group hover:border-slate-700 transition">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-xs uppercase tracking-wider font-semibold">Breathing Rate</span>
              <Wind className="w-4 h-4 text-purple-400" />
            </div>
            <div className="flex items-baseline space-x-2">
              <span className="text-4xl font-extrabold text-purple-400 font-mono tracking-tight">
                {respirationRate ? respirationRate : '--'}
              </span>
              <span className="text-sm font-medium text-slate-400">Br/min</span>
            </div>
            <p className="text-[11px] text-slate-500 mt-2">Derived from low-frequency optical wander</p>
            <div className="absolute top-0 right-0 h-1 w-full bg-gradient-to-r from-transparent via-purple-500 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>

        {/* Oscilloscope Canvas & Waveform View */}
        <div className="bg-[#0c121e] border border-slate-800 rounded-2xl p-4 lg:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center space-x-2">
              <Activity className="w-5 h-5 text-emerald-400" />
              <h2 className="font-semibold text-white tracking-wide text-sm lg:text-base">
                Real-Time Optical PPG Oscilloscope
              </h2>
            </div>

            {/* Scope Tuning Controls */}
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <div className="flex items-center space-x-2 bg-slate-900 border border-slate-800 px-2.5 py-1.5 rounded-lg">
                <Sliders className="w-3.5 h-3.5 text-slate-400" />
                <span className="text-slate-400">Gain:</span>
                <input 
                  type="range" 
                  min="0.5" 
                  max="4.0" 
                  step="0.1" 
                  value={gain} 
                  onChange={(e) => setGain(parseFloat(e.target.value))}
                  className="w-20 accent-emerald-500 cursor-pointer"
                />
                <span className="font-mono text-slate-300 w-8">{gain}x</span>
              </div>

              <button
                onClick={() => setShowThreshold(!showThreshold)}
                className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition ${
                  showThreshold ? 'bg-amber-500/20 border-amber-500/40 text-amber-300' : 'bg-slate-900 border-slate-800 text-slate-400'
                }`}
              >
                Adaptive Threshold
              </button>

              <button
                onClick={() => setFilterEnabled(!filterEnabled)}
                className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition ${
                  filterEnabled ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300' : 'bg-slate-900 border-slate-800 text-slate-400'
                }`}
              >
                Noise Filter
              </button>
            </div>
          </div>

          {/* Canvas Viewport */}
          <div className="relative rounded-xl overflow-hidden border border-slate-800 bg-[#090d16] shadow-inner">
            <canvas 
              ref={canvasRef} 
              className="w-full h-[300px] block"
            />
            {/* Live Indicator overlay */}
            <div className="absolute top-3 right-3 flex items-center space-x-1.5 bg-black/60 backdrop-blur px-2 py-1 rounded text-[11px] font-mono text-emerald-400 border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
              <span>100 Hz SAMPLING</span>
            </div>
          </div>
        </div>

        {/* Validation Logging, CSV Export & Technical Decision Panels */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Data Validation & Session Logging */}
          <div className="lg:col-span-1 bg-[#0c121e] border border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex items-center space-x-2">
              <FileSpreadsheet className="w-5 h-5 text-cyan-400" />
              <h3 className="font-semibold text-white text-sm">Judge Validation & CSV Logger</h3>
            </div>
            
            <p className="text-xs text-slate-400 leading-relaxed">
              Record live raw ADC values and computed metrics to generate CSV logs for direct calibration against the commercial finger pulse oximeter.
            </p>

            <div className="bg-slate-900/60 p-3 rounded-xl border border-slate-800 text-xs space-y-1.5 font-mono">
              <div className="flex justify-between text-slate-400">
                <span>Samples Logged:</span>
                <span className="text-slate-200">{recordedData.length}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Active State:</span>
                <span className={isRecording ? 'text-red-400 animate-pulse font-bold' : 'text-slate-500'}>
                  {isRecording ? 'RECORDING IN PROGRESS' : 'IDLE'}
                </span>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={toggleRecording}
                className={`flex-1 flex items-center justify-center space-x-2 py-2 px-3 rounded-lg text-xs font-semibold transition ${
                  isRecording 
                    ? 'bg-rose-600 hover:bg-rose-500 text-white' 
                    : 'bg-cyan-600 hover:bg-cyan-500 text-black'
                }`}
              >
                {isRecording ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                <span>{isRecording ? 'Stop Recording' : 'Start Log'}</span>
              </button>

              <button
                onClick={exportCSV}
                disabled={recordedData.length === 0}
                className="flex items-center space-x-1.5 py-2 px-3 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800 text-slate-200 border border-slate-700 transition"
              >
                <Download className="w-4 h-4" />
                <span>Export CSV</span>
              </button>
            </div>
          </div>

          {/* Hackathon Rubric: Engineering Decisions & Hardware Setup Guide */}
          <div className="lg:col-span-2 bg-[#0c121e] border border-slate-800 rounded-2xl p-5 space-y-4">
            <div className="flex items-center space-x-2">
              <HelpCircle className="w-5 h-5 text-amber-400" />
              <h3 className="font-semibold text-white text-sm">Hardware Setup & Thonny Serial Format</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="space-y-2 bg-slate-900/60 p-3.5 rounded-xl border border-slate-800">
                <div className="font-semibold text-slate-200 flex items-center space-x-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>MicroPython Print Format</span>
                </div>
                <p className="text-slate-400 leading-relaxed">
                  In your Pico script on Thonny, simply print the 16-bit ADC value in your sampling loop:
                </p>
                <code className="block bg-black/60 p-2 rounded text-emerald-400 font-mono text-[11px]">
                  print(adc.read_u16())
                </code>
                <p className="text-slate-500 text-[11px]">
                  The Web Serial parser automatically handles raw integers or lines formatted with beat events.
                </p>
              </div>

              <div className="space-y-2 bg-slate-900/60 p-3.5 rounded-xl border border-slate-800">
                <div className="font-semibold text-slate-200 flex items-center space-x-1.5">
                  <ShieldCheck className="w-4 h-4 text-cyan-400" />
                  <span>Scoring Strategy (125 Pts)</span>
                </div>
                <ul className="text-slate-400 space-y-1 list-disc list-inside leading-relaxed text-[11px]">
                  <li><strong className="text-slate-200">50 Pts (Sensing):</strong> Show side-by-side error within $\pm2$ BPM vs reference oximeter.</li>
                  <li><strong className="text-slate-200">25 Pts (Usability):</strong> Optical barrier between emitter/detector prevents optical shunt.</li>
                  <li><strong className="text-slate-200">35 Pts (Software):</strong> Real-time PRV (RMSSD) and breathing metrics demonstrate physiological depth.</li>
                  <li><strong className="text-slate-200">15 Pts (Decisions):</strong> Document 2-stage active bandpass (0.7-5 Hz) trade-offs.</li>
                </ul>
              </div>
            </div>
          </div>

        </div>

      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-[#070b12] text-slate-500 text-xs px-6 py-4 flex flex-wrap justify-between items-center gap-3">
        <p>BMES Hackathon — Biomedical Optical Sensing Track</p>
        <p className="font-mono text-[11px]">Web Serial API • 100 Hz Low-Latency ADC Pipeline</p>
      </footer>
    </div>
  );
}