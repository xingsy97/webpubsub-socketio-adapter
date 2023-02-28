const eio = require("engine.io-client");

const url = "ws://localhost:8080/client/hubs/sample_chat?access_token=...";
const socket = new eio.Socket(url, {
transports: ['websocket'],
transportOptions: {
  websocket:{
    extraHeaders: {
      'Access-Control-Allow-Origin': '*'
    }
  },
},
path: "/client/hubs/sample_chat",
subprotocols: ["json.webpubsub.azure.v1"]
});
socket.on('open', () => {
  console.log("Client conn open");
  socket.on('message', data => {console.log(data);});
  socket.on('close', () => {});
  socket.send("[from client] hello");
});