const WebSocket = require('ws');

// Connect to the server
const ws = new WebSocket('ws://localhost:8080');

// When connection opens
ws.on('open', () => {
  console.log('🔗 Connected to server!');
});

// When we receive data
ws.on('message', (data) => {
  const telemetry = JSON.parse(data);
  console.log('📊 Received:', telemetry);
});

// When connection closes
ws.on('close', () => {
  console.log('🔌 Disconnected from server');
});

// When there's an error
ws.on('error', (error) => {
  console.error('⚠️ Error:', error);
});

// Disconnect after 5 seconds (for testing)
setTimeout(() => {
  console.log('🛑 Closing connection...');
  ws.close();
}, 5000);