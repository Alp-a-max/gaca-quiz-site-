const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8 // 100 MB Limit for large images
});

// Serve static files from current directory
app.use(express.static(__dirname));

// Serve okbı.html as the main entry point
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;

// State
let rooms = {}; // { roomId: { players: [], state: 'waiting', hostId: socket.id, active: true } }
let publicQuizzes = []; // { id, title, author, questionCount, data: [] }

// Helper: Generate Short ID
function generateId() {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // --- COMMUNITY / HOME EVENTS ---
    socket.on('get_public_quizzes', () => {
        socket.emit('public_quizzes_list', publicQuizzes);
    });

    socket.on('publish_quiz', (quizData) => {
        const newQuiz = {
            id: generateId(),
            title: quizData.title || "Untitled Quiz",
            author: quizData.author || "Anonymous",
            questionCount: quizData.data.length,
            createdAt: Date.now(),
            data: quizData.data
        };
        publicQuizzes.push(newQuiz);
        console.log(`New Quiz Published: ${newQuiz.title} (${newQuiz.id})`);

        // Notify everyone (or just the publisher, but everyone is better for live updates)
        io.emit('public_quizzes_list', publicQuizzes);
        socket.emit('publish_success', { id: newQuiz.id });
    });

    // --- HOST EVENTS ---
    socket.on('create_room', (data) => {
        // Unrestricted creation? No. User requested "1453" lock.
        // Solo mode doesn't use this event (client side only).
        // Actual hosting needs the key.
        if (data.adminKey !== '1453') {
            socket.emit('error_msg', 'Access Denied: Incorrect Admin Key');
            return;
        }

        const roomId = generateId();
        rooms[roomId] = {
            id: roomId,
            hostId: socket.id,
            players: [], // { id, name, score }
            state: 'waiting',
            capacity: data.capacity || 20,
            password: data.password || null, // Optional password
            createdAt: Date.now()
        };

        socket.join(roomId);
        // Tag socket as host
        socket.roomId = roomId;
        socket.isHost = true;

        socket.emit('room_created', { roomId: roomId });
        console.log(`Room created: ${roomId} by ${socket.id} (PW: ${!!data.password})`);

        // Broadcast updated room list to everyone
        io.emit('rooms_list', getActiveRooms());
    });

    socket.on('host_update_game', (data) => {
        // Broadcast game state to players in room
        const roomId = socket.roomId;
        if (roomId && rooms[roomId]) {
            socket.to(roomId).emit('game_update', data);
        }
    });

    socket.on('host_game_start', () => {
        const roomId = socket.roomId;
        if (roomId && rooms[roomId]) {
            rooms[roomId].state = 'playing';
            socket.to(roomId).emit('game_start');
            io.emit('rooms_list', getActiveRooms()); // Update status
        }
    });

    socket.on('host_game_over', () => {
        const roomId = socket.roomId;
        if (roomId && rooms[roomId]) {
            rooms[roomId].state = 'finished';
            // close room after some time? or just mark finished
            io.emit('rooms_list', getActiveRooms());
        }
    });

    // --- PLAYER EVENTS ---
    socket.on('join_check', () => {
        // Just send the list
        socket.emit('rooms_list', getActiveRooms());
    });

    socket.on('join_room', (data) => {
        const { roomId, nickname, password } = data;
        const room = rooms[roomId];

        if (!room) {
            socket.emit('error_msg', 'Room not found');
            return;
        }
        if (room.players.length >= room.capacity) {
            socket.emit('error_msg', 'Room is full');
            return;
        }
        if (room.state !== 'waiting') {
            // Optional: Allow late join?
        }

        // Check Password
        if (room.password && room.password !== password) {
            socket.emit('error_msg', 'Incorrect Password');
            return;
        }

        socket.join(roomId);
        socket.roomId = roomId;
        socket.nickname = nickname;
        socket.score = 0;

        room.players.push({
            id: socket.id,
            name: nickname,
            score: 0
        });

        // Notify Host
        io.to(room.hostId).emit('player_joined', { name: nickname, id: socket.id });

        // Notify Player
        socket.emit('joined_success', { roomId: roomId });
    });

    socket.on('player_answer', (data) => {
        const roomId = socket.roomId;
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            // Forward to host
            io.to(room.hostId).emit('player_answer', {
                playerId: socket.id,
                answer: data.answer
            });
        }
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        if (socket.isHost) {
            // Close room
            const roomId = socket.roomId;
            if (roomId && rooms[roomId]) {
                delete rooms[roomId];
                io.to(roomId).emit('error_msg', 'Host disconnected. Game over.');
                io.emit('rooms_list', getActiveRooms());
            }
        } else {
            // Remove player
            const roomId = socket.roomId;
            if (roomId && rooms[roomId]) {
                const room = rooms[roomId];
                room.players = room.players.filter(p => p.id !== socket.id);
                // Notify Host
                io.to(room.hostId).emit('player_left', { id: socket.id });
            }
        }
    });
});

function getActiveRooms() {
    // Return array of simple room objects
    return Object.values(rooms)
        .filter(r => r.state === 'waiting')
        .map(r => ({
            id: r.id,
            count: r.players.length,
            capacity: r.capacity,
            locked: !!r.password // true if has password
        }));
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
