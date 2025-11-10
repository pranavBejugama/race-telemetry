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
        
const timerRef = useRef<number | null>(null);
const indexRef = useRef(0); 

const play = () => {
if (playing) return;
setPlaying(true);

timerRef.current = window.setInterval(() => {

  const i = indexRef.current;
  const t = i / hz;

  const mockPoint: Point = {
    type: "point",
    t: t,
    speed: 2 + Math.random(),
    current: 5 + Math.random(),
    temp: 20 + Math.random(),
  };
  pushPoint(mockPoint);
}, 1000 / hz);
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
