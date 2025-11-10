from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
import asyncio

# Create the app instance
app = FastAP (title="Telemetry Insights Backend")

# --- CORS (so your frontend on localhost:5173 can connect) ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],       # In production, specify your frontend URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Temporary in-memory telemetry data (mock data) ---
telemetry_data = [
    {"time": 1, "speed": 12.5, "battery": 99},
    {"time": 2, "speed": 13.1, "battery": 98.8},
    {"time": 3, "speed": 14.3, "battery": 98.2},
]

# --- REST endpoint: returns all telemetry data ---
@app.get("/data")
async def get_data():
    return telemetry_data

# --- WebSocket endpoint: streams telemetry data live ---
@app.websocket("/ws/replay")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("WebSocket connected!!!!")

    try:
        for point in telemetry_data:
            await websocket.send_json(point)  # send one datapoint at a time
            await asyncio.sleep(1)            # simulate 1-second intervals

        await websocket.send_json({"done": True})
        print("✅ Replay finished")
    except Exception as e:
        print("❌ WebSocket error:", e)
    finally:
        await websocket.close()
        print("🔒 WebSocket closed")

# --- Root endpoint: quick sanity check ---
@app.get("/")
def root():
    return {"message": "Telemetry backend running!"}
