from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import pyarrow.parquet as pq
import time, json, pathlib, asyncio

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

DATA_DIR = pathlib.Path("backend/storage/data")

@app.get("/api/health")
def health():
    return {"ok": True}

@app.websocket("/ws/replay")
async def ws_replay(ws: WebSocket, session_id: str = "demo_session", rate: float = 1.0):
    """Streams rows from the Parquet log, paced by their timestamps.
       rate=2.0 streams 2× faster than real-time; 0.5 is half-speed."""
    await ws.accept()
    path = DATA_DIR / f"{session_id}.parquet"
    if not path.exists():
        await ws.close(code=4404)
        return

    table = pq.read_table(path).to_pylist()
    if not table:
        await ws.close(code=4000)
        return

    t0 = table[0]["ts_ms"]
    wall0 = time.time()
    i = 0
    try:
        while i < len(table):
            now = time.time()
            target = (table[i]["ts_ms"] - t0) / 1000.0 / rate
            if (now - wall0) < target:
                await asyncio.sleep(0.01)
                continue
            await ws.send_text(json.dumps(table[i]))
            i += 1
    except WebSocketDisconnect:
        return
