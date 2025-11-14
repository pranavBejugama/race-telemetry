"use client"

import type React from "react"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { useTelemetry } from "@/hooks/useTelemetry"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Play, Pause, Wifi, WifiOff, TrendingUp, Zap, Thermometer, FileImage, FileText } from "lucide-react"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts"
import { max } from "date-fns"

interface TelemetryPoint {
  t: number // timestamp in seconds
  speed: number // m/s
  current: number // A
  temp: number // °C
}

interface WebSocketStatus {
  connected: boolean
  latency: number
  lastUpdate: Date | null
}

interface ChartDomain {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

interface series {
  speed: boolean
  current: boolean
  temp: boolean
}

interface KPIMetrics {
  avg: number
  max: number
  last: number
}

interface KPIData {
  speed: KPIMetrics
  current: KPIMetrics
  temp: KPIMetrics
}

const THRESHOLDS = {
  speed: { max: 50, warning: 45 }, // m/s
  current: { max: 100, warning: 85 }, // A
  temp: { max: 80, warning: 70 }, // °C
}

const WEBSOCKET_URL = "ws://localhost:8080/telemetry"
const MAX_BUFFER_SIZE = 120000 // 120k points max
const BATCH_INTERVAL = 100 // ms
const MIN_ZOOM_SPAN = 2 // minimum 2 seconds visible
const ZOOM_SENSITIVITY = 0.1
const CHART_WIDTH_PIXELS = 800 // Approximate chart width for downsampling calculation
const DOWNSAMPLE_THRESHOLD = 1000 // Start downsampling when more than 1000 points visible
const MOCK_DATA_INTERVAL = 50 // Generate mock data every 50ms
const MOCK_DATA_ENABLED = true // Enable mock data by default

function downsampleLTTB(data: TelemetryPoint[], threshold: number): TelemetryPoint[] {
  if (data.length <= threshold || threshold <= 2) {
    return data
  }

  const bucketSize = (data.length - 2) / (threshold - 2)
  const sampled: TelemetryPoint[] = [data[0]] // Always include first point

  let bucketIndex = 0
  for (let i = 1; i < threshold - 1; i++) {
    const bucketStart = Math.floor(bucketIndex * bucketSize) + 1
    const bucketEnd = Math.floor((bucketIndex + 1) * bucketSize) + 1
    const nextBucketStart = Math.floor((bucketIndex + 1) * bucketSize) + 1
    const nextBucketEnd = Math.min(Math.floor((bucketIndex + 2) * bucketSize) + 1, data.length - 1)

    let avgNextX = 0
    let avgNextY = 0
    let nextBucketLength = 0

    for (let j = nextBucketStart; j < nextBucketEnd; j++) {
      avgNextX += data[j].t
      avgNextY += data[j].speed
      nextBucketLength++
    }

    if (nextBucketLength > 0) {
      avgNextX /= nextBucketLength
      avgNextY /= nextBucketLength
    }

    let maxArea = -1
    let maxAreaIndex = bucketStart

    const prevPoint = sampled[sampled.length - 1]

    for (let j = bucketStart; j < bucketEnd; j++) {
      const area =
        Math.abs(
          (prevPoint.t - avgNextX) * (data[j].speed - prevPoint.speed) -
            (prevPoint.t - data[j].t) * (avgNextY - prevPoint.speed),
        ) * 0.5

      if (area > maxArea) {
        maxArea = area
        maxAreaIndex = j
      }
    }

    sampled.push(data[maxAreaIndex])
    bucketIndex++
  }

  sampled.push(data[data.length - 1]) // Always include last point
  return sampled
}

function downsampleMinMax(data: TelemetryPoint[], targetPoints: number): TelemetryPoint[] {
  if (data.length <= targetPoints) {
    return data
  }

  const bucketSize = Math.ceil(data.length / targetPoints)
  const downsampled: TelemetryPoint[] = []

  for (let i = 0; i < data.length; i += bucketSize) {
    const bucket = data.slice(i, Math.min(i + bucketSize, data.length))

    if (bucket.length === 1) {
      downsampled.push(bucket[0])
      continue
    }

    let minPoint = bucket[0]
    let maxPoint = bucket[0]
    let minValue = bucket[0].speed + bucket[0].current + bucket[0].temp
    let maxValue = minValue

    for (const point of bucket) {
      const value = point.speed + point.current + point.temp
      if (value < minValue) {
        minValue = value
        minPoint = point
      }
      if (value > maxValue) {
        maxValue = value
        maxPoint = point
      }
    }

    if (minPoint.t < maxPoint.t) {
      downsampled.push(minPoint, maxPoint)
    } else {
      downsampled.push(maxPoint, minPoint)
    }
  }

  return downsampled
}

export default function TelemetryDashboard() {
  const {
  playing, followTail, series, data, hz,
  setFollowTail, setHz,
  play, pause, toggleSeries, pushPoint, clear,
} = useTelemetry(4);

console.log('[PAGE] data.length:', data.length);

  const [wsStatus, setWsStatus] = useState<WebSocketStatus>({
    connected: false,
    latency: 0,
    lastUpdate: null,
  })
  const [isPlaying, setIsPlaying] = useState(false)

  const [playbackRate, setPlaybackRate] = useState("1")
  const [selectedSession, setSelectedSession] = useState("session-1")
  const [isMockMode, setIsMockMode] = useState(false)

  const [chartDomain, setChartDomain] = useState<ChartDomain | null>(null)

  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState<{ x: number; domain: ChartDomain } | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>()
  const heartbeatIntervalRef = useRef<NodeJS.Timeout>()
  const batchTimeoutRef = useRef<NodeJS.Timeout>()
  const pendingDataRef = useRef<TelemetryPoint[]>([])
  const reconnectAttemptsRef = useRef(0)
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const mockDataIntervalRef = useRef<NodeJS.Timeout>()
  const mockTimeRef = useRef(0)

  const kpiData = useMemo((): KPIData => {
    if (data.length === 0) {
      return {
        speed: { avg: 0, max: 0, last: 0 },
        current: { avg: 0, max: 0, last: 0 },
        temp: { avg: 0, max: 0, last: 0 },
      }
    }

    const visibleData = data.filter((point) => {
      return series.speed || series.current || series.temp
    })

    if (visibleData.length === 0) {
      return {
        speed: { avg: 0, max: 0, last: 0 },
        current: { avg: 0, max: 0, last: 0 },
        temp: { avg: 0, max: 0, last: 0 },
      }
    }

    const calculateMetrics = (values: number[]): KPIMetrics => {
      if (values.length === 0) return { avg: 0, max: 0, last: 0 }

      let sum = 0
      let max = values[0]



      for (let i = 0; i < values.length; i++) {
        const val = values[i]
        sum += val
        if (val > max) max = val
      }

      return {
        avg: sum / values.length,
        max,
        last: values[values.length - 1],
      }
    }

    return {
      speed: series.speed ? calculateMetrics(visibleData.map((d) => d.speed)) : { avg: 0, max: 0, last: 0 },
      current: series.current
        ? calculateMetrics(visibleData.map((d) => d.current))
        : { avg: 0, max: 0, last: 0 },
      temp: series.temp ? calculateMetrics(visibleData.map((d) => d.temp)) : { avg: 0, max: 0, last: 0 },
    }
  }, [data, series])

  const generateMockData = useCallback(() => {
    if (!isPlaying) return

    const rate = Number.parseFloat(playbackRate)
    const deltaT = (MOCK_DATA_INTERVAL / 1000) * rate

    mockTimeRef.current += deltaT

    const baseSpeed = 30 + Math.sin(mockTimeRef.current * 0.1) * 15
    const baseCurrent = 60 + Math.sin(mockTimeRef.current * 0.15) * 25
    const baseTemp = 50 + Math.sin(mockTimeRef.current * 0.05) * 20

    const point: TelemetryPoint = {
      t: mockTimeRef.current,
      speed: Math.max(0, baseSpeed + (Math.random() - 0.5) * 5),
      current: Math.max(0, baseCurrent + (Math.random() - 0.5) * 10),
      temp: Math.max(0, baseTemp + (Math.random() - 0.5) * 8),
    }

    pendingDataRef.current.push(point)

    if (batchTimeoutRef.current) {
      clearTimeout(batchTimeoutRef.current)
    }

    batchTimeoutRef.current = setTimeout(() => {
      if (pendingDataRef.current.length > 0) {
        setData((prevData) => {
          const newData = [...prevData, ...pendingDataRef.current]
          pendingDataRef.current = []

          if (newData.length > MAX_BUFFER_SIZE) {
            return newData.slice(-MAX_BUFFER_SIZE)
          }
          return newData
        })

        setWsStatus((prev) => ({ ...prev, lastUpdate: new Date() }))
      }
    }, BATCH_INTERVAL)
  }, [isPlaying, playbackRate])

  const connectWebSocket = useCallback(() => {
    if (isMockMode) return

    try {
      const ws = new WebSocket(WEBSOCKET_URL)
      wsRef.current = ws

      ws.onopen = () => {
        console.log("[v0] WebSocket connected")
        setWsStatus((prev) => ({ ...prev, connected: true }))
        setIsMockMode(false)
        reconnectAttemptsRef.current = 0

        if (mockDataIntervalRef.current) {
          clearInterval(mockDataIntervalRef.current)
          mockDataIntervalRef.current = undefined
        }

        heartbeatIntervalRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            const pingTime = Date.now()
            ws.send(JSON.stringify({ type: "ping", timestamp: pingTime }))
          }
        }, 5000)
      }

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)

          if (message.type === "pong") {
            const latency = Date.now() - message.timestamp
            setWsStatus((prev) => ({ ...prev, latency }))
            return
          }

          if (message.type === "telemetry" && isPlaying) {
            const point: TelemetryPoint = {
              t: message.t,
              speed: message.speed,
              current: message.current,
              temp: message.temp,
            }

            pendingDataRef.current.push(point)

            if (batchTimeoutRef.current) {
              clearTimeout(batchTimeoutRef.current)
            }

            batchTimeoutRef.current = setTimeout(() => {
              if (pendingDataRef.current.length > 0) {
                setData((prevData) => {
                  const newData = [...prevData, ...pendingDataRef.current]
                  pendingDataRef.current = []

                  if (newData.length > MAX_BUFFER_SIZE) {
                    return newData.slice(-MAX_BUFFER_SIZE)
                  }
                  return newData
                })

                setWsStatus((prev) => ({ ...prev, lastUpdate: new Date() }))
              }
            }, BATCH_INTERVAL)
          }
        } catch (error) {
          console.error("[v0] Error parsing WebSocket message:", error)
        }
      }

      ws.onclose = () => {
        console.log("[v0] WebSocket disconnected, switching to mock data mode")
        setWsStatus((prev) => ({ ...prev, connected: false }))

        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current)
        }

        if (MOCK_DATA_ENABLED && !isMockMode) {
          setIsMockMode(true)
        } else {
          const backoffDelay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000)
          reconnectAttemptsRef.current++

          if (reconnectAttemptsRef.current < 3) {
            reconnectTimeoutRef.current = setTimeout(() => {
              connectWebSocket()
            }, backoffDelay)
          } else if (MOCK_DATA_ENABLED) {
            setIsMockMode(true)
          }
        }
      }

      ws.onerror = () => {
        console.log("[v0] WebSocket connection failed, will use mock data")
      }
    } catch (error) {
      console.log("[v0] Failed to create WebSocket connection, using mock data")
      if (MOCK_DATA_ENABLED) {
        setIsMockMode(true)
      }
    }
  }, [isPlaying, isMockMode])

  /*useEffect(() => {
    if (isMockMode && isPlaying) {
      console.log("[v0] Starting mock data generation")
      mockDataIntervalRef.current = setInterval(generateMockData, MOCK_DATA_INTERVAL)

      return () => {
        if (mockDataIntervalRef.current) {
          clearInterval(mockDataIntervalRef.current)
        }
      }
    }
  }, [isMockMode, isPlaying, generateMockData])*/

  useEffect(() => {
    connectWebSocket()

    return () => {
      if (wsRef.current) {
        wsRef.current.close()
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current)
      }
      if (batchTimeoutRef.current) {
        clearTimeout(batchTimeoutRef.current)
      }
      if (mockDataIntervalRef.current) {
        clearInterval(mockDataIntervalRef.current)
      }
    }
  }, [connectWebSocket])

  const chartData = useMemo(() => {
  console.log('[CHARTDATA] Recalculating, data:', data.length, 'domain:', chartDomain);
  
  if (data.length === 0) return [];
  
  // If no domain set, return all data
  if (!chartDomain || isNaN(chartDomain.xMin) || isNaN(chartDomain.xMax)) {
    return data;
  }
  
  // Filter to visible range
  return data.filter(d => d.t >= chartDomain.xMin && d.t <= chartDomain.xMax);
}, [data, chartDomain]);

  // Initialize chart domain when data first arrives
useEffect(() => {
  if (data.length > 0) {
    const minT = Math.min(...data.map((d) => d.t))
    const maxT = Math.max(...data.map((d) => d.t))

    console.log('[INIT DOMAIN] minT:', minT, 'maxT:', maxT);

    setChartDomain({
      xMin: followTail ? Math.max(0, maxT - 30) : minT,
      xMax: maxT,
      yMin: 0,
      yMax: 100,
    })
  }
}, [data.length])

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      console.log('WHEEL EVENT FIRED');
    
       if (playing) {
        console.log('blocked - playing');
        return;
    }

    e.preventDefault()
    e.stopPropagation() 

      if (!chartDomain || data.length === 0) {
        console.log('[WHEEL] EARLY RETURN - no domain or no data');
      return;
      }

      e.preventDefault()
      setFollowTail(false)

      const rect = chartContainerRef.current?.getBoundingClientRect()
      if (!rect) { console.log('[WHEEL] EARLY RETURN - no rect');
      return;
    }

      const minT = Math.min(...data.map((d) => d.t))
      const maxT = Math.max(...data.map((d) => d.t))
      const totalDataSpan = maxT - minT

      console.log('[WHEEL] minT:', minT, 'maxT:', maxT, 'span:', totalDataSpan);

      const MIN_ZOOM_SPAN = 2;
      const MAX_ZOOM_SPAN = totalDataSpan * 1.2;

      const mouseX = (e.clientX - rect.left) / rect.width
      const currentSpan = chartDomain.xMax - chartDomain.xMin
      const zoomFactor = e.deltaY > 0 ? 1 + ZOOM_SENSITIVITY : 1 - ZOOM_SENSITIVITY

       console.log('[WHEEL] currentSpan:', currentSpan, 'zoomFactor:', zoomFactor);

      let newSpan = currentSpan * zoomFactor
      newSpan = Math.max(MIN_ZOOM_SPAN, Math.min(MAX_ZOOM_SPAN, newSpan))

      console.log('[WHEEL] newSpan:', newSpan);


      const mouseT = chartDomain.xMin + mouseX * currentSpan
      let newXMin = mouseT - (mouseT - chartDomain.xMin) * (newSpan / currentSpan)
      let newXMax = newXMin + newSpan

      console.log('[WHEEL] BEFORE CLAMP - newXMin:', newXMin, 'newXMax:', newXMax);

      if (newXMin < minT){
        newXMin = minT
        newXMax = newXMin + newSpan

      }
      if (newXMax > maxT){
        newXMax = maxT
        newXMin = newXMax - newSpan

      }

      if (newXMin < minT || newXMax > maxT) {
  const center = (minT + maxT) / 2;
  newXMin = center - newSpan / 2;
  newXMax = center + newSpan / 2;
  
  // If span is too large for data, just show all data
  if (newXMin < minT) {
    newXMin = minT;
    newXMax = maxT;
  }
}

// Safety check: ensure valid range
if (newXMin >= newXMax || isNaN(newXMin) || isNaN(newXMax)) {
  console.log('[WHEEL] Invalid range, skipping update');
  return;
}

      console.log('[WHEEL] AFTER CLAMP - newXMin:', newXMin, 'newXMax:', newXMax);
      console.log('[WHEEL] Setting new domain!');

      setChartDomain({
        ...chartDomain,
        xMin: newXMin,
        xMax: newXMax,
      })
    },
    [chartDomain, data, playing],
  )
  /**What happens:**
- State updates with new boundaries
- Chart re-renders with new visible range
- Lines redraw to show the zoomed view

---

## 🎯 Visual Summary
```
Before zoom (showing 5 seconds):
|----+----+----+----+----|
3s   4s   5s   6s   7s   8s
          ↑ mouse

After zoom IN (showing 4 seconds):
     |----+----+----+----|
     3.5s 4.5s 5.5s 6.5s 7.5s
               ↑ mouse (still here!) */

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!chartDomain) return

      setIsDragging(true)
      setFollowTail(false)
      setDragStart({
        x: e.clientX,
        domain: { ...chartDomain },
      })
    },
    [chartDomain],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging || !dragStart || !chartContainerRef.current) return

      const rect = chartContainerRef.current.getBoundingClientRect()
      const deltaX = (e.clientX - dragStart.x) / rect.width
      const span = dragStart.domain.xMax - dragStart.domain.xMin
      const deltaT = deltaX * span

      const newXMin = dragStart.domain.xMin - deltaT
      const newXMax = dragStart.domain.xMax - deltaT

       // ADD YOUR BOUNDARY LOGIC HERE
      // Define boundaries
      

      const minTime = 0
      const maxTime = (data.length - 1) / hz

      let clampedXMin = newXMin
      let clampedXMax = newXMax

      if (clampedXMin < minTime) {
        const overflow = minTime - clampedXMin
        clampedXMin = minTime
        clampedXMax = clampedXMax + overflow
      }

      if (clampedXMax > maxTime){
        const overflow = clampedXMax - maxTime
        clampedXMax = maxTime
        clampedXMin = clampedXMin - overflow

      }
console.log('maxTime:', maxTime)
console.log('newXMax:', newXMax)
console.log('clampedXMax:', clampedXMax)
      setChartDomain({
        ...dragStart.domain,
        xMin: clampedXMin,
        xMax: clampedXMax,
      })
    },
    [isDragging, dragStart, data, hz],
  )

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
    setDragStart(null)
  }, [])

  const handleDoubleClick = useCallback(() => {
    if (data.length === 0) return

    const minT = Math.min(...data.map((d) => d.t))
    const maxT = Math.max(...data.map((d) => d.t))

    setChartDomain({
      xMin: minT,
      xMax: maxT,
      yMin: 0,
      yMax: 100,
    })
    setFollowTail(true)
  }, [data])

  const CustomTooltip = useMemo(() => {
    return ({ active, payload, label }: any) => {
      if (!active || !payload || !payload.length) return null

      return (
        <div className="bg-card border border-border rounded-lg p-3 shadow-lg">
          <p className="text-sm font-medium mb-2">Time: {Number(label).toFixed(2)}s</p>
          {payload.map((entry: any, index: number) => (
            <p key={index} className="text-sm" style={{ color: entry.color }}>
              {entry.name}: {entry.value.toFixed(2)}{" "}
              {entry.name === "speed" ? "m/s" : entry.name === "current" ? "A" : "°C"}
            </p>
          ))}
        </div>
      )
    }
  }, [])

  const KPICard = ({
    title,
    icon: Icon,
    metrics,
    unit,
    threshold,
    enabled,
  }: {
    title: string
    icon: React.ElementType
    metrics: KPIMetrics
    unit: string
    threshold: { max: number; warning: number }
    enabled: boolean
  }) => {
    const isWarning = metrics.max >= threshold.warning
    const isCritical = metrics.max >= threshold.max

    return (
      <Card className={`p-4 ${!enabled ? "opacity-50" : ""}`}>
        <div className="flex items-center gap-2 mb-3">
          <Icon className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">{title}</h3>
          {enabled && (isCritical || isWarning) && (
            <Badge variant={isCritical ? "destructive" : "secondary"} className="text-xs">
              {isCritical ? "Critical" : "Warning"}
            </Badge>
          )}
        </div>

        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <div className="text-xs text-muted-foreground mb-1">Avg</div>
            <div className="font-mono">
              {enabled ? metrics.avg.toFixed(1) : "--"} {unit}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Max</div>
            <div
              className={`font-mono ${
                enabled && isCritical ? "text-destructive" : enabled && isWarning ? "text-yellow-500" : ""
              }`}
            >
              {enabled ? metrics.max.toFixed(1) : "--"} {unit}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Last</div>
            <div className="font-mono">
              {enabled ? metrics.last.toFixed(1) : "--"} {unit}
            </div>
          </div>
        </div>
      </Card>
    )
  }

  const togglePlayback = () => {
    if (playing) {
      pause();
    }else {
      if (data.length > 0){
        clear();
        setChartDomain(null);
      }
      play();
      setFollowTail(true);
    }
  }

  const toggleFollowTail = () => {
    const newValue = !followTail;
    setFollowTail(newValue);

    if (newValue && data.length > 0) {
      const minT = Math.min(...data.map((d) => d.t));
      const maxT = Math.max(...data.map((d) => d.t));
      setChartDomain({
        xMin: Math.max(minT, maxT - 30),
        xMax: maxT,
        yMin: 0,
        yMax: 25,
      });
    }
  };

  const memoizedKpiData = useMemo((): KPIData => {
    if (chartData.length === 0) {
      return {
        speed: { avg: 0, max: 0, last: 0 },
        current: { avg: 0, max: 0, last: 0 },
        temp: { avg: 0, max: 0, last: 0 },
      }
    }

    const calculateMetrics = (values: number[]): KPIMetrics => {
      if (values.length === 0) return { avg: 0, max: 0, last: 0 }

      let sum = 0
      let max = values[0]

      for (let i = 0; i < values.length; i++) {
        const val = values[i]
        sum += val
        if (val > max) max = val
      }

      return {
        avg: sum / values.length,
        max,
        last: values[values.length - 1],
      }
    }

    return {
      speed: series.speed ? calculateMetrics(chartData.map((d) => d.speed)) : { avg: 0, max: 0, last: 0 },
      current: series.current
        ? calculateMetrics(chartData.map((d) => d.current))
        : { avg: 0, max: 0, last: 0 },
      temp: series.temp ? calculateMetrics(chartData.map((d) => d.temp)) : { avg: 0, max: 0, last: 0 },
    }
  }, [chartData, series])

  const exportToPNG = useCallback(async () => {
    if (!chartContainerRef.current) return

    try {
      const chartElement = chartContainerRef.current
      const rect = chartElement.getBoundingClientRect()

      const canvas = document.createElement("canvas")
      const ctx = canvas.getContext("2d")
      if (!ctx) return

      canvas.width = rect.width * 2
      canvas.height = rect.height * 2
      ctx.scale(2, 2)

      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--background") || "#000000"
      ctx.fillRect(0, 0, rect.width, rect.height)

      const svgData = `
        <svg width="${rect.width}" height="${rect.height}" xmlns="http://www.w3.org/2000/svg">
          <foreignObject width="100%" height="100%">
            <div xmlns="http://www.w3.org/1999/xhtml">
              ${chartElement.innerHTML}
            </div>
          </foreignObject>
        </svg>
      `

      const img = new Image()
      img.crossOrigin = "anonymous"

      img.onload = () => {
        ctx.drawImage(img, 0, 0, rect.width, rect.height)

        canvas.toBlob((blob) => {
          if (!blob) return

          const url = URL.createObjectURL(blob)
          const link = document.createElement("a")
          link.href = url
          link.download = `telemetry-chart-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.png`
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          URL.revokeObjectURL(url)
        }, "image/png")
      }

      img.onerror = () => {
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--foreground") || "#ffffff"
        ctx.font = "14px monospace"
        ctx.fillText(`Telemetry Export - ${new Date().toLocaleString()}`, 20, 30)
        ctx.fillText(`Data Points: ${chartData.length}`, 20, 50)
        ctx.fillText(`Time Range: ${chartDomain?.xMin.toFixed(1)}s - ${chartDomain?.xMax.toFixed(1)}s`, 20, 70)

        canvas.toBlob((blob) => {
          if (!blob) return

          const url = URL.createObjectURL(blob)
          const link = document.createElement("a")
          link.href = url
          link.download = `telemetry-chart-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.png`
          document.body.appendChild(link)
          link.click()
          document.body.removeChild(link)
          URL.revokeObjectURL(url)
        }, "image/png")
      }

      const svgBlob = new Blob([svgData], { type: "image/svg+xml" })
      const svgUrl = URL.createObjectURL(svgBlob)
      img.src = svgUrl
    } catch (error) {
      console.error("[v0] Error exporting PNG:", error)
    }
  }, [chartData, chartDomain])

  const exportToCSV = useCallback(() => {
    if (chartData.length === 0) return

    try {
      const headers = ["Time (s)"]
      if (series.speed) headers.push("Speed (m/s)")
      if (series.current) headers.push("Current (A)")
      if (series.temp) headers.push("Temperature (°C)")

      const rows = [headers.join(",")]

      chartData.forEach((point) => {
        const row = [point.t.toFixed(3)]
        if (series.speed) row.push(point.speed.toFixed(3))
        if (series.current) row.push(point.current.toFixed(3))
        if (series.temp) row.push(point.temp.toFixed(3))
        rows.push(row.join(","))
      })

      const metadata = [
        `# Telemetry Data Export`,
        `# Generated: ${new Date().toISOString()}`,
        `# Session: ${selectedSession}`,
        `# Data Points: ${chartData.length}`,
        `# Time Range: ${chartDomain?.xMin.toFixed(3)}s - ${chartDomain?.xMax.toFixed(3)}s`,
        `# Visible Series: ${Object.entries(series)
          .filter(([_, visible]) => visible)
          .map(([name]) => name)
          .join(", ")}`,
        `#`,
      ]

      const csvContent = [...metadata, ...rows].join("\n")

      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" })
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `telemetry-data-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.csv`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)

      console.log(`[v0] Exported ${chartData.length} data points to CSV`)
    } catch (error) {
      console.error("[v0] Error exporting CSV:", error)
    }
  }, [chartData, series, selectedSession, chartDomain])

  return (
    <div className="min-h-screen bg-background text-foreground p-4">
      <div className="max-w-7xl mx-auto space-y-4">
        <Card className="p-4">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-4">
              <Select value={selectedSession} onValueChange={setSelectedSession}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="session-1">Session 1</SelectItem>
                  <SelectItem value="session-2">Session 2</SelectItem>
                  <SelectItem value="session-3">Session 3</SelectItem>
                </SelectContent>
              </Select>

              <Button variant={playing ? "default" : "outline"} size="sm" onClick={togglePlayback}>
                {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </Button>

              <Button variant={followTail ? "default" : "outline"} size="sm" onClick={toggleFollowTail}>
                Follow Tail
              </Button>

              <Select value={playbackRate} onValueChange={setPlaybackRate}>
                <SelectTrigger className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0.5">0.5×</SelectItem>
                  <SelectItem value="1">1×</SelectItem>
                  <SelectItem value="2">2×</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-4">
              <div className="text-sm text-muted-foreground">

                Window: {chartData.length > 0 ? `${chartData.length} points` : "No data"}
              </div>

              <Badge
                variant={wsStatus.connected ? "default" : isMockMode ? "secondary" : "destructive"}
                className="gap-1"
              >
                {wsStatus.connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                {wsStatus.connected ? `${wsStatus.latency}ms` : isMockMode ? "Mock Data" : "Disconnected"}
              </Badge>
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <KPICard
            title="Speed"
            icon={TrendingUp}
            metrics={memoizedKpiData.speed}
            unit="m/s"
            threshold={THRESHOLDS.speed}
            enabled={series.speed}
          />
          <KPICard
            title="Current"
            icon={Zap}
            metrics={memoizedKpiData.current}
            unit="A"
            threshold={THRESHOLDS.current}
            enabled={series.current}
          />
          <KPICard
            title="Temperature"
            icon={Thermometer}
            metrics={memoizedKpiData.temp}
            unit="°C"
            threshold={THRESHOLDS.temp}
            enabled={series.temp}
          />
        </div>

        <Card className="p-4">
          <div className="h-96 w-full">
            <div className="flex items-center gap-4 mb-4">
              <div className="text-sm font-medium">Series:</div>
              <Button
                variant={series.speed ? "default" : "outline"}
                size="sm"
                onClick={() => toggleSeries("speed")}
                className="h-6 px-2 text-xs"
              >
                Speed
              </Button>
              <Button
                variant={series.current ? "default" : "outline"}
                size="sm"
                onClick={() => toggleSeries("current")}
                className="h-6 px-2 text-xs"
              >
                Current
              </Button>
              <Button
                variant={series.temp ? "default" : "outline"}
                size="sm"
                onClick={() => toggleSeries("temp")}
                className="h-6 px-2 text-xs"
              >
                Temperature
              </Button>
            </div>

            <div
              ref={chartContainerRef}
              className="h-80 cursor-crosshair select-none"
              tabIndex={0} 
              onWheelCapture={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onDoubleClick={handleDoubleClick}
            >
              
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    scale="linear"
                    domain={chartDomain ? [chartDomain.xMin, chartDomain.xMax] : ["auto", "auto"]}
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={12}
                    tickFormatter={(value) => `${value.toFixed(1)}s`}
                  />
                  <YAxis 
  stroke="hsl(var(--muted-foreground))" 
  fontSize={12} 
  domain={[0, 25]}  // ← Fixed range so all series are visible
/>
                  <Tooltip content={<CustomTooltip />} />
                  <Legend />

                  {series.speed && (
                    <Line
                     type="monotone"
    dataKey="speed"
    stroke="#f97316"
    strokeWidth={2}
    dot={false}
    isAnimationActive={false}
    name="Speed"
                    />
                  )}

                  {series.current && (
                    <Line
                      type="monotone"
    dataKey="current"
    stroke="#06b6d4"
    strokeWidth={2}
    dot={false}
    isAnimationActive={false}
    name="Current"
                    />
                  )}

                  {series.temp && (
                    <Line
                      type="monotone"
    dataKey="temp"
    stroke="#6366f1"  // ← Blue
    strokeWidth={2}
    dot={false}
    isAnimationActive={false}
    name="Temperature"
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="text-xs text-muted-foreground mt-2">
              Wheel: zoom at cursor | Drag: pan | Double-click: reset view
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between text-sm">
            <div className="text-muted-foreground">
              Points: {data.length} / {MAX_BUFFER_SIZE} | Rendered: {chartData.length}
            </div>
            <div className="text-muted-foreground">
              Last Update: {wsStatus.lastUpdate?.toLocaleTimeString() || "Never"}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={exportToPNG}
                disabled={chartData.length === 0}
                className="h-8 px-3 text-xs gap-1 bg-transparent"
              >
                <FileImage className="w-3 h-3" />
                PNG
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={exportToCSV}
                disabled={chartData.length === 0}
                className="h-8 px-3 text-xs gap-1 bg-transparent"
              >
                <FileText className="w-3 h-3" />
                CSV
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
