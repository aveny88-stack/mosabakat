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

    // ربط شاشة العرض (البروجكتر) بالغرفة دون إضافتها كطالب
    socket.on('registerDisplay', (pin) => {
        const cleanPin = String(pin || '').trim();
        if (rooms[cleanPin]) {
            socket.join(cleanPin);
            socket.emit('displayRegisteredSuccess');
        } else {
            socket.emit('errorMsg', 'رمز الغرفة (PIN) غير صحيح أو لم يتم إنشاء الغرفة بعد!');
        }
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
        const { name, pin, isDisplay } = data;
        const cleanPin = String(pin || '').trim();
        if (rooms[cleanPin]) {
            // إذا كان المتصل هو شاشة العرض، اربطه بالغرفة فقط دون إضافته لقائمة الطلاب
            if (isDisplay) {
                socket.join(cleanPin);
                socket.emit('displayRegisteredSuccess');
                return;
            }

            rooms[cleanPin].players[socket.id] = {
                name: name,
                score: 0,
                treeLevel: 1
            };
            socket.join(cleanPin);
            socket.emit('joinedSuccess', {
                bgStyle: rooms[cleanPin].bgStyle,
                music: rooms[cleanPin].music
            });
            updateRoomPlayers(cleanPin);
        } else {
            socket.emit('joinError', 'رمز الغرفة غير صحيح!');
        }
    });

    socket.on('submitAnswer', (data) => {
        const { pin, answer } = data;
        const room = rooms[pin];
        if (!room || !room.quizActive) return;

        const q = room.questions[room.currentQuestion];
        const player = room.players[socket.id];
        if (!player) return;

        // إذا كان السؤال نصياً مفتوحاً (مثل الاسم واللقب)، أرسله مباشرة إلى لوحة المعلم
        if (q.type === 'text') {
            io.to(room.host).emit('receiveTextAnswer', {
                playerName: player.name,
                answerText: String(answer).trim()
            });
            return;
        }

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

        if (isCorrect) {
            player.score += 100;
            if (player.score >= 300 && player.score < 600) player.treeLevel = 2;
            else if (player.score >= 600 && player.score < 1000) player.treeLevel = 3;
            else if (player.score >= 1000 && player.score < 1500) player.treeLevel = 4;
            else if (player.score >= 1500) player.treeLevel = 5;
        }

        socket.emit('scoreUpdate', {
            score: player.score,
            treeState: getTreeName(player.treeLevel)
        });
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
            // إرسال النتيجة النهائية لكل طالب بحسب نقاطه
            for (let playerId in room.players) {
                const p = room.players[playerId];
                io.to(playerId).emit('quizEnded', {
                    score: p.score,
                    treeState: getTreeName(p.treeLevel)
                });
            }
            // إرسال لوحة الشرف لشاشة العرض
            const sortedPlayers = Object.values(room.players).sort((a, b) => b.score - a.score);
            io.to(pin).emit('gameOver', sortedPlayers);
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
        totalQuestions: room.questions.length,
        total: room.questions.length,
        type: q.type,
        text: q.text,
        translation: q.translation,
        hint: q.translation,
        options: q.options || [],
        image: q.image,
        time: q.time
    });
    io.to(room.host).emit('teacherQuestionView', {
        questionNumber: room.currentQuestion + 1,
        type: q.type,
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`الخادم يعمل على المنفذ ${PORT}`);
});