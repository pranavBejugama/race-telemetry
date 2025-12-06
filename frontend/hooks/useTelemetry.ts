import { useRef, useState } from "react";
import type { Point } from "@/lib/types/telemtery";

type SeriesFlags = { speed: boolean; current: boolean; temp: boolean};

export function useTelemetry(initialHz = 4) {
    const [playing, setPlaying] = useState(false);
    const [followTail, setFollowTail] = useState(true);
    const [series, setSeries] = useState<SeriesFlags>({
        speed: true,
        current: true,
        temp: true,
});
  const [data, setData] = useState<Point[]>([]);
  const [hz, setHz] = useState(initialHz);

  const [wsConnected, setWsConnected] = useState(false);
  const [useMockData, setUseMockData] = useState(false);
        
const timerRef = useRef<number | null>(null);
const indexRef = useRef(0);
const wsRef = useRef<WebSocket | null>(null);

const play = () => {
  if (playing) return;
  setPlaying(true);

  // Try to connect to WebSocket first
  const ws = new WebSocket('ws://localhost:8080');
  wsRef.current = ws;

  ws.onopen = () => {
    console.log('✅ WebSocket connected - using real data');
    setWsConnected(true);
    setUseMockData(false);
  };

  ws.onmessage = (event) => {
    const telemetry = JSON.parse(event.data);
    
    // Convert server data to your Point format
    const point: Point = {
      type: "point",
      t: telemetry.timestamp / 1000, // Convert ms to seconds
      speed: telemetry.speed / 10, // Scale to your range (0-25)
      current: telemetry.current / 5, // Scale to your range
      temp: telemetry.temperature / 10, // Scale to your range
    };
    
    pushPoint(point);
  };

  ws.onerror = () => {
    console.log('⚠️ WebSocket failed - using mock data');
    setWsConnected(false);
    setUseMockData(true);
    startMockDataGenerator();
  };

  ws.onclose = () => {
    console.log('🔌 WebSocket closed - using mock data');
    setWsConnected(false);
    setUseMockData(true);
    startMockDataGenerator();
  };
};

const pause = () => {
  setPlaying(false);
  if (timerRef.current !== null) {
    clearInterval(timerRef.current);
    timerRef.current = null;
  }
 }

const toggleSeries = (key: keyof SeriesFlags) => setSeries(prev => ({ ...prev, [key]: !prev[key] }));
const pushPoint = (p: Point) => {
  setData(prev => { 
    const maxPoints = 60 * 60 * 4;
    const next = [...prev, p];
    if (next.length > maxPoints){
      next.splice(0, next.length - maxPoints);
    }
    return next;
    });
    indexRef.current += 1;
  };

const clear = () => {
  setData([]);
  indexRef.current = 0;
}

  return {
    playing, followTail, series, data, hz,
    setFollowTail, setHz,
    play, pause, toggleSeries, pushPoint, clear,
  };

}
