const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fileUpload = require('express-fileupload');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(fileUpload());
app.use(express.json());

// مجلد رفع الصور
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

app.post('/upload', (req, res) => {
    if (!req.files || !req.files.image) {
        return res.status(400).json({ error: 'No image uploaded' });
    }
    const image = req.files.image;
    const fileName = Date.now() + '_' + image.name;
    const uploadPath = path.join(uploadDir, fileName);

    image.mv(uploadPath, (err) => {
        if (err) return res.status(500).json({ error: err });
        res.json({ imageUrl: `/uploads/${fileName}` });
    });
});

let rooms = {};

io.on('connection', (socket) => {
    socket.on('createRoom', () => {
        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[pin] = {
            host: socket.id,
            players: {},
            questions: [],
            currentQuestion: 0,
            quizActive: false,
            title: '',
            bgStyle: 'color1',
            music: 'none',
            isSelfPaced: false
        };
        socket.join(pin);
        socket.emit('roomCreated', { pin });
    });

    socket.on('startQuiz', (data) => {
        const { pin, title, bgStyle, music, isSelfPaced, questions } = data;
        if (rooms[pin]) {
            rooms[pin].title = title;
            rooms[pin].bgStyle = bgStyle;
            rooms[pin].music = music;
            rooms[pin].isSelfPaced = isSelfPaced;
            rooms[pin].questions = questions;
            rooms[pin].quizActive = true;
            rooms[pin].currentQuestion = 0;

            io.to(pin).emit('quizStarted', { title, bgStyle, music });
            sendQuestionToRoom(pin);
        }
    });

    socket.on('joinRoom', (data) => {
        const { name, pin } = data;
        if (rooms[pin]) {
            rooms[pin].players[socket.id] = {
                name: name,
                score: 0,
                treeLevel: 1
            };
            socket.join(pin);
            socket.emit('joinedSuccess', {
                bgStyle: rooms[pin].bgStyle,
                music: rooms[pin].music
            });
            updateRoomPlayers(pin);
        } else {
            socket.emit('joinError', 'رمز الغرفة غير صحيح!');
        }
    });

    socket.on('submitAnswer', (data) => {
        const { pin, answer } = data;
        const room = rooms[pin];
        if (!room || !room.quizActive) return;

        const q = room.questions[room.currentQuestion];
        let isCorrect = false;

        if (q.type === 'mcq') {
            isCorrect = (parseInt(answer) === q.correct);
        } else if (q.type === 'tf') {
            isCorrect = (answer === q.correct);
        } else if (q.type === 'arrange' || q.type === 'fill') {
            const userAns = String(answer).trim().toLowerCase();
            const correctAns = String(q.type === 'arrange' ? q.correctSentence : q.correctFill).trim().toLowerCase();
            isCorrect = (userAns === correctAns);
        }

        const player = room.players[socket.id];
        if (player && isCorrect) {
            player.score += 100;
            if (player.score >= 300 && player.score < 600) player.treeLevel = 2;
            else if (player.score >= 600 && player.score < 1000) player.treeLevel = 3;
            else if (player.score >= 1000 && player.score < 1500) player.treeLevel = 4;
            else if (player.score >= 1500) player.treeLevel = 5;
        }
        updateRoomPlayers(pin);
    });

    socket.on('nextQuestionManual', (pin) => {
        const room = rooms[pin];
        if (!room) return;
        room.currentQuestion++;
        if (room.currentQuestion < room.questions.length) {
            sendQuestionToRoom(pin);
        } else {
            room.quizActive = false;
            io.to(pin).emit('quizEnded', {
                score: room.players[socket.id]?.score || 0,
                treeState: getTreeName(room.players[socket.id]?.treeLevel || 1)
            });
        }
    });

    socket.on('disconnect', () => {
        for (let pin in rooms) {
            if (rooms[pin].players[socket.id]) {
                delete rooms[pin].players[socket.id];
                updateRoomPlayers(pin);
            }
        }
    });
});

function sendQuestionToRoom(pin) {
    const room = rooms[pin];
    const q = room.questions[room.currentQuestion];
    io.to(pin).emit('newQuestion', {
        questionNumber: room.currentQuestion + 1,
        total: room.questions.length,
        type: q.type,
        text: q.text,
        translation: q.translation,
        options: q.options,
        image: q.image,
        time: q.time
    });
    io.to(room.host).emit('teacherQuestionView', {
        questionNumber: room.currentQuestion + 1,
        text: q.text
    });
}

function updateRoomPlayers(pin) {
    const room = rooms[pin];
    if (!room) return;
    const playersArr = Object.values(room.players).map(p => ({
        name: p.name,
        score: p.score,
        treeLevel: p.treeLevel
    }));
    io.to(room.host).emit('updatePlayers', playersArr);
}

function getTreeName(level) {
    const trees = ['🌱 بذور', '🌿 شتلة صغيرة', '🌳 شجرة نامية', '🌴 شجرة مثمرة', '🌲 غابة زاهية'];
    return trees[level - 1] || trees[0];
}

const PORT = 3001;
server.listen(PORT, () => {
const PORT = process.env.PORT || 3001;});