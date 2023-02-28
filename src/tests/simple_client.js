const io  = require("socket.io-client");
const { WebPubSubServiceClient } = require('@azure/web-pubsub');

async function main() {
	const serviceClient = new WebPubSubServiceClient("Endpoint=http://localhost;Port=8080;AccessKey=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGH;Version=1.0", "Hub");

	const token = await serviceClient.getClientAccessToken({ userId: "user1" });
	const socket = io.connect('http://localhost:9001', {transports:['websocket']});

	console.log(token);

	socket.on('connection', function () {
		console.log('connection!');
		socket.emit('input', 'asdasdg');
	});

	socket.on('connected', function () {
		console.log('connected!');
		socket.emit('input', 'asdasdg');
	});

	socket.on('echo', function (data) {
		console.log('echo : ' + data);
	});

	socket.on('disconnect', function () {
		console.log('disconnected!');
	});

	const readline = require('readline').createInterface({
		input: process.stdin,
		output: process.stdout
	});

	function onMessage(message) {
		if (message != '/exit') {
			socket.emit('input', 'Client says, ' + message);
			readline.question('', onMessage);
		} else {
			process.exit(); 
		}
	}

	socket.emit('echo','hello')
	readline.question('', onMessage);
}

main()