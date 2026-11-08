
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Heart, Activity, Wind, Clock, Download, Play, Square,
  RefreshCw, Sliders, AlertCircle, CheckCircle2, Info, Zap,
  ShieldCheck, TrendingUp, Radio, FileSpreadsheet, HelpCircle, Cpu
} from 'lucide-react';

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [baudRate, setBaudRate] = useState(115200);
  const [portInfo, setPortInfo] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');

  const [instantBpm, setInstantBpm] = useState(null);
  const [avgBpm, setAvgBpm] = useState(null);
  const [rmssd, setRmssd] = useState(null);
  const [respirationRate, setRespirationRate] = useState(null);
  const [signalQuality, setSignalQuality] = useState('NO_FINGER');
  const [isBeatActive, setIsBeatActive] = useState(false);
  const [latestAdc, setLatestAdc] = useState(null);
  const [latestRepeat, setLatestRepeat] = useState(null);
  const [lastSampleTimestamp, setLastSampleTimestamp] = useState(null);
  const [samplingCheckTime, setSamplingCheckTime] = useState(0);
  const [receivedSampleCount, setReceivedSampleCount] = useState(0);

  const [canvasDiagnostics, setCanvasDiagnostics] = useState({
    sampleCount: 0,
    width: 0,
    height: 0,
    contextAvailable: false,
    drawLoopRunning: false,
    serialChunkCount: 0,
    lastSerialLine: 'N/A'
  });

  const [isRecording, setIsRecording] = useState(false);
  const [recordedData, setRecordedData] = useState([]);
  const [recordingStartTime, setRecordingStartTime] = useState(null);

  const isRecordingRef = useRef(false);
  const recordedDataRef = useRef([]);
  const recordingStartTimeRef = useRef(null);

  const [gain, setGain] = useState(1.5);
  const [showThreshold, setShowThreshold] = useState(true);
  const [filterEnabled, setFilterEnabled] = useState(true);

  const canvasRef = useRef(null);
  const serialPortRef = useRef(null);
  const readerRef = useRef(null);
  const isReadingRef = useRef(false);

  const canvasDiagnosticsRef = useRef({
    width: 0,
    height: 0,
    contextAvailable: false,
    drawLoopRunning: false
  });

  const serialChunkCountRef = useRef(0);
  const lastSerialLineRef = useRef('N/A');

  const BUFFER_LEN = 600;
  const rawBufferRef = useRef(new Array(BUFFER_LEN).fill(32768));
  const filteredBufferRef = useRef(new Array(BUFFER_LEN).fill(32768));
  const thresholdBufferRef = useRef(new Array(BUFFER_LEN).fill(32768));
  const sampleCountRef = useRef(0);

  const lastPeakTimeRef = useRef(0);
  const ibiHistoryRef = useRef([]);
  const baselineBufferRef = useRef([]);

  const emaAlpha = 0.25;
  const lastFilteredRef = useRef(32768);

  // ==========================================
  // Recording helper
  // ==========================================

  const saveSample = useCallback((row) => {
    if (!isRecordingRef.current) return;

    recordedDataRef.current.push(row);

    // Update the visible sample count without losing the ref data.
    setRecordedData([...recordedDataRef.current]);
  }, []);

  // ==========================================
  // Signal processing
  // ==========================================

  const processSample = useCallback((
    rawVal,
    timestamp,
    externalMetrics = null
  ) => {
    sampleCountRef.current = Math.min(
      sampleCountRef.current + 1,
      BUFFER_LEN
    );

    let filteredVal = rawVal;

    if (filterEnabled) {
      filteredVal =
        emaAlpha * rawVal +
        (1 - emaAlpha) * lastFilteredRef.current;

      lastFilteredRef.current = filteredVal;
    }

    rawBufferRef.current.shift();
    rawBufferRef.current.push(rawVal);

    filteredBufferRef.current.shift();
    filteredBufferRef.current.push(filteredVal);

    const recentWindow =
      filteredBufferRef.current.slice(-150);

    const minVal = Math.min(...recentWindow);
    const maxVal = Math.max(...recentWindow);
    const amplitude = maxVal - minVal;
    const dynamicThresh = minVal + 0.65 * amplitude;

    thresholdBufferRef.current.shift();
    thresholdBufferRef.current.push(dynamicThresh);

    let currentQuality = 'NO_FINGER';

    if (externalMetrics) {
      currentQuality =
        externalMetrics.rep >= externalMetrics.need
          ? 'EXCELLENT'
          : externalMetrics.rep > 0
            ? 'POOR'
            : 'NO_FINGER';

      setSignalQuality(currentQuality);

      setInstantBpm(
        externalMetrics.bpm > 0
          ? externalMetrics.bpm
          : null
      );

      setAvgBpm(
        externalMetrics.bpm > 0
          ? externalMetrics.bpm
          : null
      );
    } else {
      // Demo-mode processing. BPM is supplied by the simulator.
      currentQuality = amplitude > 100
        ? 'EXCELLENT'
        : 'POOR';

      setSignalQuality(currentQuality);
    }

    if (isRecordingRef.current) {
      const startTime =
        recordingStartTimeRef.current ?? timestamp;

      saveSample({
        timestamp: (timestamp - startTime).toFixed(1),
        raw: externalMetrics
          ? externalMetrics.pulse
          : rawVal,
        filtered: Math.round(filteredVal),
        bpm: externalMetrics
          ? externalMetrics.bpm
          : (instantBpm ?? ''),
        avgBpm: externalMetrics
          ? externalMetrics.bpm
          : (avgBpm ?? ''),
        rmssd: rmssd ?? '',
        quality: currentQuality
      });
    }
  }, [
    filterEnabled,
    instantBpm,
    avgBpm,
    rmssd,
    saveSample
  ]);

  // ==========================================
  // Diagnostics
  // ==========================================

  useEffect(() => {
    const intervalId = setInterval(() => {
      setSamplingCheckTime(performance.now());

      const canvas = canvasRef.current;

      setCanvasDiagnostics({
        sampleCount: sampleCountRef.current,
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
        contextAvailable:
          canvasDiagnosticsRef.current.contextAvailable,
        drawLoopRunning:
          canvasDiagnosticsRef.current.drawLoopRunning,
        serialChunkCount: serialChunkCountRef.current,
        lastSerialLine: lastSerialLineRef.current
      });
    }, 250);

    return () => clearInterval(intervalId);
  }, []);

  // ==========================================
  // Pico Web Serial connection
  // ==========================================

  const connectSerial = async () => {
    if (!('serial' in navigator)) {
      alert(
        'Web Serial is not supported. Please use Chrome or Edge.'
      );
      return;
    }

    try {
      setConnectionStatus('Connecting');

      const port = await navigator.serial.requestPort();

      await port.open({
        baudRate: Number(baudRate)
      });

      serialPortRef.current = port;

      setIsConnected(true);
      setIsDemoMode(false);
      setConnectionStatus('Connected');
      setPortInfo('Raspberry Pi Pico');

      sampleCountRef.current = 0;
      setLatestAdc(null);
      setLatestRepeat(null);
      setLastSampleTimestamp(null);
      setReceivedSampleCount(0);

      serialChunkCountRef.current = 0;
      lastSerialLineRef.current = 'Waiting for data';

      const decoder = new TextDecoderStream();

      const streamClosed =
        port.readable.pipeTo(decoder.writable);

      streamClosed.catch(error => {
        console.error('Serial stream closed:', error);
      });

      const reader = decoder.readable.getReader();

      readerRef.current = reader;
      isReadingRef.current = true;

      let lineBuffer = '';

      const readLoop = async () => {
        try {
          while (isReadingRef.current) {
            const { value, done } = await reader.read();

            if (done) break;
            if (!value) continue;

            serialChunkCountRef.current += 1;
            lineBuffer += value;

            const lines = lineBuffer.split(/\r?\n/);
            lineBuffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();

              if (!trimmed) continue;

              console.log('Pico serial line:', trimmed);
              lastSerialLineRef.current = trimmed.slice(0, 80);

              const parts = trimmed
                .split(',')
                .map(item => Number(item.trim()));

              // Expected format: pulse,bpm,rep,need
              if (
                parts.length === 4 &&
                parts.every(Number.isFinite) &&
                parts[0] >= -60 &&
                parts[0] <= 60 &&
                parts[1] >= 0 &&
                parts[1] <= 250 &&
                parts[2] >= 0 &&
                parts[2] <= 100 &&
                parts[3] >= 0 &&
                parts[3] <= 100
              ) {
                const [pulse, bpm, rep, need] = parts;
                const timestamp = performance.now();

                setLatestAdc(pulse);
                setLatestRepeat(rep);
                setLastSampleTimestamp(timestamp);
                setReceivedSampleCount(count => count + 1);

                const graphValue = 32768 + pulse * 100;

                processSample(graphValue, timestamp, {
                  pulse,
                  bpm,
                  rep,
                  need
                });
              } else {
                console.warn(
                  'Unexpected Pico data format:',
                  trimmed
                );
              }
            }
          }
        } catch (error) {
          console.error('Serial read error:', error);
          setConnectionStatus('Read Error');
        }
      };

      readLoop();

    } catch (error) {
      console.error('Pico connection error:', error);
      setConnectionStatus('Connection Error');
      setIsConnected(false);

      alert('Pico connection failed: ' + error.message);
    }
  };

  const disconnectSerial = async () => {
    isReadingRef.current = false;

    try {
      if (readerRef.current) {
        await readerRef.current.cancel();
        readerRef.current.releaseLock();
        readerRef.current = null;
      }

      if (serialPortRef.current) {
        await serialPortRef.current.close();
        serialPortRef.current = null;
      }
    } catch (error) {
      console.error('Disconnect error:', error);
    }

    setIsConnected(false);
    setConnectionStatus('Disconnected');
    setPortInfo('');
  };

  // ==========================================
  // Demo mode: fixed 72 BPM simulated signal
  // ==========================================

  useEffect(() => {
    if (!isDemoMode || isConnected) return;

    setConnectionStatus('Demo Running');
    setPortInfo('Built-in Simulator');

    const sampleRate = 25;
    const simulatedBpm = 72;
    const phaseStep =
      (2 * Math.PI * simulatedBpm) / (60 * sampleRate);

    let phase = 0;
    let sampleIndex = 0;

    const demoInterval = setInterval(() => {
      phase = (phase + phaseStep) % (2 * Math.PI);
      sampleIndex += 1;

      const systolic = Math.exp(
        -Math.pow((phase - 0.55) / 0.18, 2)
      );

      const secondary = 0.22 * Math.exp(
        -Math.pow((phase - 1.35) / 0.28, 2)
      );

      const baseline = Math.sin(sampleIndex * 0.008) * 5;
      const noise = (Math.random() - 0.5) * 2;

      const pulse =
        systolic * 24 +
        secondary * 8 +
        baseline +
        noise -
        8;

      const timestamp = performance.now();

      setLatestAdc(Number(pulse.toFixed(1)));
      setLatestRepeat(85);
      setLastSampleTimestamp(timestamp);
      setReceivedSampleCount(count => count + 1);

      processSample(32768 + pulse * 100, timestamp, {
        pulse,
        bpm: simulatedBpm,
        rep: 85,
        need: 40
      });
    }, 1000 / sampleRate);

    return () => clearInterval(demoInterval);
  }, [isDemoMode, isConnected, processSample]);

  // ==========================================
  // Canvas waveform rendering
  // ==========================================

  useEffect(() => {
    let animationFrameId;

    const render = () => {
      const canvas = canvasRef.current;

      if (!canvas) {
        animationFrameId = requestAnimationFrame(render);
        return;
      }

      const ctx = canvas.getContext('2d');
      const width = canvas.width;
      const height = canvas.height;

      canvasDiagnosticsRef.current = {
        width,
        height,
        contextAvailable: ctx !== null,
        drawLoopRunning: true
      };

      if (!ctx || width <= 0 || height <= 0) {
        animationFrameId = requestAnimationFrame(render);
        return;
      }

      ctx.fillStyle = '#FFF5E1';
      ctx.fillRect(0, 0, width, height);

      ctx.lineWidth = 1;
      ctx.strokeStyle = '#DCC8A3';

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

      ctx.strokeStyle = '#800020';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
      ctx.setLineDash([]);

      const data = filteredBufferRef.current;
      const thresholdData = thresholdBufferRef.current;

      const sampleCount = Math.min(
        sampleCountRef.current,
        data.length
      );

      const displayData = data.slice(data.length - sampleCount);
      const displayThreshold =
        thresholdData.slice(thresholdData.length - sampleCount);

      if (displayData.length > 1) {
        const recent = displayData.slice(-200);
        const localMin = Math.min(...recent);
        const localMax = Math.max(...recent);
        const range = Math.max(localMax - localMin, 100);
        const center = (localMin + localMax) / 2;

        const yMin = center - range * 0.7;
        const yMax = center + range * 0.7;

        const scaleY = value => {
          const normalized =
            (value - yMin) / (yMax - yMin);

          const adjusted =
            (normalized - 0.5) * gain + 0.5;

          return height -
            Math.min(1, Math.max(0, adjusted)) * height;
        };

        if (showThreshold) {
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(128, 0, 32, 0.55)';
          ctx.lineWidth = 1.5;

          displayThreshold.forEach((value, index) => {
            const x =
              (index / (displayThreshold.length - 1)) * width;
            const y = scaleY(value);

            if (index === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });

          ctx.stroke();
        }

        ctx.beginPath();
        ctx.strokeStyle = '#800020';
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.shadowBlur = 8;
        ctx.shadowColor = 'rgba(128, 0, 32, 0.35)';

        displayData.forEach((value, index) => {
          const x =
            (index / (displayData.length - 1)) * width;
          const y = scaleY(value);

          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });

        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      canvasDiagnosticsRef.current.drawLoopRunning = false;
      cancelAnimationFrame(animationFrameId);
    };
  }, [gain, showThreshold]);

  // Canvas resize
  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        const rect =
          canvasRef.current.parentElement.getBoundingClientRect();

        canvasRef.current.width = Math.max(1, rect.width);
        canvasRef.current.height = 300;
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  // ==========================================
  // Recording and CSV export
  // ==========================================

  const toggleRecording = () => {
    if (!isRecordingRef.current) {
      recordedDataRef.current = [];
      setRecordedData([]);

      const startTime = performance.now();

      recordingStartTimeRef.current = startTime;
      setRecordingStartTime(startTime);

      isRecordingRef.current = true;
      setIsRecording(true);
    } else {
      isRecordingRef.current = false;
      setIsRecording(false);
    }
  };

  const exportCSV = () => {
    const rows = recordedDataRef.current;

    if (rows.length === 0) {
      alert('No samples recorded yet. Start logging and wait for samples.');
      return;
    }

    const headers = [
      'Time_ms',
      'Pulse_or_Raw_ADC',
      'Filtered_Value',
      'Instant_BPM',
      'Average_BPM',
      'RMSSD_ms',
      'Signal_Quality'
    ];

    const csvRows = rows.map(row => [
      row.timestamp,
      row.raw,
      row.filtered,
      row.bpm,
      row.avgBpm,
      row.rmssd,
      row.quality
    ].map(value => {
      const text = String(value ?? '');

      return /[",\n]/.test(text)
        ? `"${text.replace(/"/g, '""')}"`
        : text;
    }).join(','));

    const csv = [
      headers.join(','),
      ...csvRows
    ].join('\r\n');

    const blob = new Blob(
      [csv],
      { type: 'text/csv;charset=utf-8;' }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download =
      `PPG_Session_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // ==========================================
  // UI status
  // ==========================================

  const qualityBadge = useMemo(() => {
    switch (signalQuality) {
      case 'EXCELLENT':
        return {
          text: 'Pulse Signal Confirmed',
          color: 'bg-[#800020]/20 text-[#3B0A12] border-[#DCC8A3]/40'
        };

      case 'GOOD':
        return {
          text: 'Good Signal',
          color: 'bg-[#F7ECD4] text-[#9B1D30] border-[#DCC8A3]/50'
        };

      case 'POOR':
        return {
          text: 'Weak Signal',
          color: 'bg-[#800020]/30 text-[#3B0A12] border-[#DCC8A3]/50'
        };

      case 'MOTION_ARTIFACT':
        return {
          text: 'Motion Artifact',
          color: 'bg-[#9B1D30]/20 text-[#3B0A12] border-[#DCC8A3]/50'
        };

      default:
        return {
          text: 'Waiting for Signal',
          color: 'bg-[#F7ECD4]/60 text-[#3B0A12]/75 border-[#DCC8A3]/30'
        };
    }
  }, [signalQuality]);

  const signalQualityLabel = {
    EXCELLENT: 'Excellent',
    GOOD: 'Good',
    POOR: 'Poor',
    NO_FINGER: 'No Signal',
    MOTION_ARTIFACT: 'Motion Artifact'
  }[signalQuality] || 'N/A';

  const isReceivingData =
    (isConnected || isDemoMode) &&
    lastSampleTimestamp !== null &&
    samplingCheckTime - lastSampleTimestamp < 1000;

  // ==========================================
  // Dashboard
  // ==========================================

  return (
    <div className="min-h-screen bg-[#FFF5E1] text-[#3B0A12] flex flex-col font-sans">
      <header className="border-b border-[#5E0F1A] bg-[#3B0A12]/90 backdrop-blur sticky top-0 z-30 px-4 lg:px-8 py-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center space-x-3">
          <div className="p-2.5 bg-[#800020]/30 rounded-xl border border-[#DCC8A3] text-[#FFF5E1]">
            <Heart className={`w-6 h-6 ${isBeatActive ? 'scale-125 text-[#B0303C] fill-[#B0303C]' : 'text-[#FFF5E1]'}`} />
          </div>

          <div>
            <div className="flex items-center space-x-2">
              <h1 className="font-bold text-lg text-[#FFF5E1] tracking-tight">
                PulseWave BioSense
              </h1>
              <span className="text-[11px] font-mono uppercase bg-[#800020]/30 text-[#FFF5E1] px-2 py-0.5 rounded border border-[#DCC8A3]">
                BMES Hackathon
              </span>
            </div>

            <p className="text-xs text-[#F7ECD4]">
              RPi Pico Optical PPG & Pulse-Rate Variability Monitor
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center space-x-1.5 bg-[#F7ECD4] border border-[#DCC8A3]/30 rounded-lg px-2.5 py-1.5 text-xs">
            <Cpu className="w-3.5 h-3.5 text-[#3B0A12]/75" />
            <span className="text-[#3B0A12]/75">Baud:</span>

            <select
              value={baudRate}
              disabled={isConnected}
              onChange={event => setBaudRate(Number(event.target.value))}
              className="bg-transparent text-[#3B0A12]/90 outline-none cursor-pointer"
            >
              <option value={9600}>9600</option>
              <option value={57600}>57600</option>
              <option value={115200}>115200</option>
              <option value={230400}>230400</option>
            </select>
          </div>

          {!isConnected ? (
            <button
              onClick={connectSerial}
              className="flex items-center space-x-2 bg-[#800020] hover:bg-[#B0303C] text-[#FFF5E1] font-semibold px-4 py-1.5 rounded-lg text-xs transition shadow-md"
            >
              <Zap className="w-4 h-4 fill-current" />
              <span>Connect Pico</span>
            </button>
          ) : (
            <button
              onClick={disconnectSerial}
              className="flex items-center space-x-2 bg-[#5E0F1A] hover:bg-[#B0303C] text-[#FFF5E1] border border-[#DCC8A3] px-3.5 py-1.5 rounded-lg text-xs transition"
            >
              <Square className="w-3.5 h-3.5" />
              <span>Disconnect</span>
            </button>
          )}

          <button
            onClick={() => {
              if (isConnected) disconnectSerial();
              setIsDemoMode(current => !current);
            }}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition ${
              isDemoMode
                ? 'bg-[#800020]/30 border-[#DCC8A3]/60 text-[#9B1D30]'
                : 'bg-[#F7ECD4] border-[#DCC8A3]/30 text-[#3B0A12]/75'
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            <span>{isDemoMode ? 'Stop Demo' : 'Simulator Mode'}</span>
          </button>
        </div>
      </header>

      <main className="flex-1 p-4 lg:p-6 max-w-7xl w-full mx-auto space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3 bg-[#EFE2C6] border border-[#DCC8A3]/30 p-3 rounded-xl text-xs">
          <div className="flex items-center space-x-2">
            <span className={`w-2.5 h-2.5 rounded-full ${
              isConnected
                ? 'bg-green-600 animate-ping'
                : isDemoMode
                  ? 'bg-[#9B1D30] animate-pulse'
                  : 'bg-[#9B1D30]/60'
            }`} />

            <span className="text-[#3B0A12]/85 font-medium">
              Status: {connectionStatus}
            </span>

            {portInfo && (
              <span className="text-[#3B0A12]/60">
                ({portInfo})
              </span>
            )}
          </div>

          <div className="flex items-center space-x-3">
            <div className={`px-2.5 py-1 rounded-md border text-xs font-medium ${qualityBadge.color}`}>
              {qualityBadge.text}
            </div>

            <div className="flex items-center space-x-1.5 text-[#3B0A12]/75 bg-[#F7ECD4] px-2 py-1 rounded border border-[#DCC8A3]/30">
              <span className={`w-2 h-2 rounded-full ${isBeatActive ? 'bg-[#9B1D30]' : 'bg-[#F7ECD4]'}`} />
              <span className="font-mono text-[10px]">PULSE</span>
            </div>
          </div>
        </div>

        {/* Metric cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-[#F7ECD4] border border-[#DCC8A3]/30 rounded-2xl p-5">
            <div className="flex items-center justify-between text-[#3B0A12]/75 mb-2">
              <span className="text-xs uppercase tracking-wider font-semibold">Instant Heart Rate</span>
              <Heart className="w-4 h-4 text-[#9B1D30]" />
            </div>
            <div className="flex items-baseline space-x-2">
              <span className="text-4xl font-extrabold text-[#3B0A12] font-mono">
                {instantBpm ?? '--'}
              </span>
              <span className="text-sm font-medium">BPM</span>
            </div>
            <p className="text-[11px] text-[#3B0A12]/60 mt-2">
              Latest pulse-rate estimate
            </p>
          </div>

          <div className="bg-[#F7ECD4] border border-[#DCC8A3]/30 rounded-2xl p-5">
            <div className="flex items-center justify-between text-[#3B0A12]/75 mb-2">
              <span className="text-xs uppercase tracking-wider font-semibold">Average Heart Rate</span>
              <Activity className="w-4 h-4 text-[#9B1D30]" />
            </div>
            <div className="flex items-baseline space-x-2">
              <span className="text-4xl font-extrabold text-[#3B0A12] font-mono">
                {avgBpm ?? '--'}
              </span>
              <span className="text-sm font-medium">BPM</span>
            </div>
            <p className="text-[11px] text-[#3B0A12]/60 mt-2">
              Average reported rate
            </p>
          </div>

          <div className="bg-[#F7ECD4] border border-[#DCC8A3]/30 rounded-2xl p-5">
            <div className="flex items-center justify-between text-[#3B0A12]/75 mb-2">
              <span className="text-xs uppercase tracking-wider font-semibold">RMSSD</span>
              <TrendingUp className="w-4 h-4 text-[#9B1D30]" />
            </div>
            <div className="flex items-baseline space-x-2">
              <span className="text-4xl font-extrabold text-[#3B0A12] font-mono">
                {rmssd ?? '--'}
              </span>
              <span className="text-sm font-medium">ms</span>
            </div>
            <p className="text-[11px] text-[#3B0A12]/60 mt-2">
              Not calculated from Pico CSV
            </p>
          </div>

          <div className="bg-[#F7ECD4] border border-[#DCC8A3]/30 rounded-2xl p-5">
            <div className="flex items-center justify-between text-[#3B0A12]/75 mb-2">
              <span className="text-xs uppercase tracking-wider font-semibold">Respiration</span>
              <Wind className="w-4 h-4 text-[#9B1D30]" />
            </div>
            <div className="flex items-baseline space-x-2">
              <span className="text-4xl font-extrabold text-[#3B0A12] font-mono">
                {respirationRate ?? '--'}
              </span>
              <span className="text-sm font-medium">/min</span>
            </div>
            <p className="text-[11px] text-[#3B0A12]/60 mt-2">
              Not supplied by Pico stream
            </p>
          </div>
        </div>

        {/* Waveform */}
        <section className="bg-[#F7ECD4] border border-[#DCC8A3]/30 rounded-2xl p-4 lg:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center space-x-2">
              <Activity className="w-5 h-5 text-[#9B1D30]" />
              <h2 className="font-semibold text-[#3B0A12] text-sm lg:text-base">
                Real-Time Optical PPG Oscilloscope
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs">
              <div className="flex items-center space-x-2 bg-[#F7ECD4] border border-[#DCC8A3]/30 px-2.5 py-1.5 rounded-lg">
                <Sliders className="w-3.5 h-3.5" />
                <span>Gain:</span>
                <input
                  type="range"
                  min="0.5"
                  max="4"
                  step="0.1"
                  value={gain}
                  onChange={event => setGain(Number(event.target.value))}
                  className="w-20 accent-[#9B1D30]"
                />
                <span className="font-mono">{gain.toFixed(1)}x</span>
              </div>

              <button
                onClick={() => setShowThreshold(value => !value)}
                className="px-2.5 py-1.5 rounded-lg border text-xs"
              >
                {showThreshold ? 'Hide Threshold' : 'Show Threshold'}
              </button>

              <button
                onClick={() => setFilterEnabled(value => !value)}
                className="px-2.5 py-1.5 rounded-lg border text-xs"
              >
                {filterEnabled ? 'Smoothing On' : 'Smoothing Off'}
              </button>
            </div>
          </div>

          <div className="relative rounded-xl overflow-hidden border border-[#DCC8A3]/30 bg-[#FFF5E1] shadow-inner">
            <canvas
              ref={canvasRef}
              className="w-full h-[300px] block"
            />

            <div className="absolute top-3 right-3 flex items-center space-x-1.5 bg-[#EFE2C6] px-2 py-1 rounded text-[11px] font-mono text-[#5E0F1A] border border-[#DCC8A3]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#9B1D30] animate-ping" />
              <span>25 Hz SAMPLING</span>
            </div>
          </div>
        </section>

        {/* Recording and diagnostics */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <section className="lg:col-span-1 bg-[#F7ECD4] border border-[#DCC8A3]/30 rounded-2xl p-5 space-y-4">
            <div className="flex items-center space-x-2">
              <FileSpreadsheet className="w-5 h-5 text-[#9B1D30]" />
              <h3 className="font-semibold text-[#3B0A12] text-sm">
                Session Recording & CSV Logger
              </h3>
            </div>

            <p className="text-xs text-[#3B0A12]/75 leading-relaxed">
              Record incoming Pico or simulator samples and export them
              for analysis.
            </p>

            <div className="bg-[#EFE2C6] p-3 rounded-xl text-xs space-y-2 font-mono">
              <div className="flex justify-between">
                <span>Samples Logged:</span>
                <span>{recordedData.length}</span>
              </div>

              <div className="flex justify-between">
                <span>Recording:</span>
                <span className={isRecording ? 'font-bold text-[#9B1D30]' : ''}>
                  {isRecording ? 'ACTIVE' : 'IDLE'}
                </span>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={toggleRecording}
                disabled={!isConnected && !isDemoMode}
                className="flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-semibold bg-[#800020] hover:bg-[#B0303C] disabled:opacity-40 text-[#FFF5E1]"
              >
                {isRecording
                  ? <Square className="w-4 h-4" />
                  : <Play className="w-4 h-4" />}
                {isRecording ? 'Stop Recording' : 'Start Log'}
              </button>

              <button
                onClick={exportCSV}
                disabled={recordedData.length === 0}
                className="flex items-center gap-1.5 py-2 px-3 rounded-lg text-xs font-medium bg-[#EFE2C6] hover:bg-[#DCC8A3] disabled:opacity-40 border border-[#DCC8A3]/50"
              >
                <Download className="w-4 h-4" />
                Export CSV
              </button>
            </div>
          </section>

          <section className="lg:col-span-2 bg-[#F7ECD4] border border-[#DCC8A3]/30 rounded-2xl p-5 space-y-4">
            <div className="flex items-center space-x-2">
              <HelpCircle className="w-5 h-5 text-[#9B1D30]" />
              <h3 className="font-semibold text-[#3B0A12] text-sm">
                Hardware Setup & Live Diagnostics
              </h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
              <div className="space-y-2 bg-[#EFE2C6] p-3.5 rounded-xl">
                <div className="font-semibold flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-[#9B1D30]" />
                  MicroPython Serial Format
                </div>

                <p>
                  The Pico should print four comma-separated values:
                </p>

                <code className="block bg-[#F7ECD4] p-2 rounded text-[#9B1D30] font-mono">
                  pulse,bpm,rep,need
                </code>

                <p className="text-[#3B0A12]/60">
                  Example: 31,85,52,40
                </p>
              </div>

              <div className="space-y-2 bg-[#EFE2C6] p-3.5 rounded-xl">
                <div className="font-semibold flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-[#9B1D30]" />
                  Live Sensor Status
                </div>

                <ul className="space-y-1 list-disc list-inside leading-relaxed">
                  <li>Connection: {isConnected ? 'Connected' : isDemoMode ? 'Demo' : 'Disconnected'}</li>
                  <li>Pulse value: {latestAdc ?? 'N/A'}</li>
                  <li>Repeat score: {latestRepeat === null ? 'N/A' : `${latestRepeat}%`}</li>
                  <li>Samples received: {receivedSampleCount}</li>
                  <li>Serial chunks: {canvasDiagnostics.serialChunkCount}</li>
                  <li>Last serial line: {canvasDiagnostics.lastSerialLine}</li>
                  <li>Waveform samples: {canvasDiagnostics.sampleCount}/{BUFFER_LEN}</li>
                  <li>Canvas: {canvasDiagnostics.width} × {canvasDiagnostics.height}</li>
                  <li>Canvas context: {canvasDiagnostics.contextAvailable ? 'Available' : 'Unavailable'}</li>
                  <li>Draw loop: {canvasDiagnostics.drawLoopRunning ? 'Running' : 'Stopped'}</li>
                  <li>Signal quality: {signalQualityLabel}</li>
                  <li>Sampling: {isReceivingData ? 'Receiving data' : 'Waiting for data'}</li>
                </ul>
              </div>
            </div>
          </section>
        </div>
      </main>

      <footer className="border-t border-[#DCC8A3]/40 bg-[#FFF5E1] text-[#3B0A12]/60 text-xs px-6 py-4 flex flex-wrap justify-between items-center gap-3">
        <p>BMES Hackathon — Biomedical Optical Sensing Track</p>
        <p className="font-mono text-[11px]">Web Serial API • 25 Hz Pulse Data Pipeline</p>
      </footer>
    </div>
  );
}
