// Import WebSocket library (this loads code from node_modules/ws/)
const WebSocket = require('ws');

// Create WebSocket server on port 8080
const wss = new WebSocket.Server({ port: 8080 });

console.log('🚀 WebSocket server running on ws://localhost:8080');

// This runs when a client connects
wss.on('connection', (ws) => {
  console.log('✅ Client connected!');

  // Send telemetry data every 100ms
  const interval = setInterval(() => {
    // Generate mock telemetry
    const telemetry = {
      timestamp: Date.now(),
      speed: Math.random() * 100,
      current: Math.random() * 50,
      temperature: Math.random() * 150
    };

    // Send as JSON string
    ws.send(JSON.stringify(telemetry));
  }, 100);

  // When client disconnects, stop sending data
  ws.on('close', () => {
    console.log('❌ Client disconnected');
    clearInterval(interval);
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error('⚠️ WebSocket error:', error);
  });
});