import { initializeApp } from "firebase/app";
import {
    getFirestore,
    doc,
    onSnapshot,
    updateDoc,
    setDoc,
    deleteDoc,
    addDoc,
    getDoc, // [추가됨] 데이터를 한번만 읽어오는 함수
    collection,
    query,
    orderBy,
    limit,
    serverTimestamp
} from "firebase/firestore";

// 1. Firebase 설정 (본인의 키값 유지!)
const firebaseConfig = {
    apiKey: "API_KEY_입력",
    authDomain: "PROJECT_ID.firebaseapp.com",
    projectId: "PROJECT_ID",
    storageBucket: "PROJECT_ID.appspot.com",
    messagingSenderId: "SENDER_ID",
    appId: "APP_ID"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// --- 전역 변수 ---
const MY_ID = 'guest_' + Math.random().toString(36).substr(2, 9);
console.log("나의 ID:", MY_ID);

let amIInside = false;
let myTimerInterval;
let otherUserTimerInterval;
let queueUnsubscribe = null;

// DOM 요소
const queueScreen = document.getElementById('queue-screen');
const roomScreen = document.getElementById('room-screen');
const queueMsg = document.getElementById('queue-msg');
const timeLeftDisplay = document.getElementById('time-left');
const myRankDisplay = document.getElementById('my-rank');
const currentUserTimeDisplay = document.getElementById('current-user-time');
const canvas = document.getElementById('drawing-board');
const ctx = canvas.getContext('2d');
const msgInput = document.getElementById('msg-input');
const msgLog = document.getElementById('msg-log');
const leaveBtn = document.getElementById('leave-btn');

// ==========================================
// 1. 이벤트 리스너
// ==========================================
leaveBtn.addEventListener('click', leaveRoom);
msgInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});
window.addEventListener('resize', resizeCanvas);
window.addEventListener('beforeunload', () => {
    removeFromQueue();
});


// ==========================================
// 2. 방 감시 및 입장 로직
// ==========================================
const roomRef = doc(db, "world", "room1");
const queueColRef = collection(db, "world", "room1", "waiting");
// [추가됨] 그림 데이터가 저장될 위치
const canvasRef = doc(db, "world", "canvas_data");

onSnapshot(roomRef, (snapshot) => {
    if (!snapshot.exists()) {
        setDoc(roomRef, { occupant: null, expireAt: null });
        return;
    }

    const data = snapshot.data();
    const now = Date.now();
    const expireTimeMillis = data.expireAt ? data.expireAt.toMillis() : 0;

    if (!data.occupant || expireTimeMillis < now) {
        tryEnterRoom();
    } else {
        if (data.occupant === MY_ID) {
            if (!amIInside) enterRoomMode(data.expireAt);
        } else {
            showQueueMode(data);
        }
    }
});

async function tryEnterRoom() {
    const nextExpire = new Date();
    nextExpire.setMinutes(nextExpire.getMinutes() + 5);

    try {
        await updateDoc(roomRef, {
            occupant: MY_ID,
            expireAt: nextExpire,
            startTime: serverTimestamp()
        });
        await removeFromQueue();
        console.log("방 입장 성공!");
    } catch (e) {
        console.log("입장 경쟁 실패:", e);
    }
}


// ==========================================
// 3. 화면 모드 (입장 시 그림 불러오기 추가)
// ==========================================

function enterRoomMode(expireTime) {
    amIInside = true;
    queueScreen.classList.add('hidden');
    roomScreen.classList.remove('hidden');

    if (queueUnsubscribe) {
        queueUnsubscribe();
        queueUnsubscribe = null;
    }
    if (otherUserTimerInterval) clearInterval(otherUserTimerInterval);

    // 1. 캔버스 크기 맞추기
    resizeCanvas();
    // 2. [핵심] 이전 사람들의 흔적(그림) 불러오기
    loadCanvasData();

    subscribeMessages();

    if (myTimerInterval) clearInterval(myTimerInterval);
    myTimerInterval = setInterval(() => {
        const left = expireTime.toMillis() - Date.now();
        if (left <= 0) {
            leaveRoom();
        } else {
            const minutes = Math.floor(left / 1000 / 60);
            const seconds = Math.floor((left / 1000) % 60);
            document.getElementById('my-timer').innerText =
                `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
    }, 100);
}

function showQueueMode(roomData) {
    amIInside = false;
    roomScreen.classList.add('hidden');
    queueScreen.classList.remove('hidden');

    if (!queueUnsubscribe) {
        const myQueueRef = doc(queueColRef, MY_ID);
        setDoc(myQueueRef, {
            userId: MY_ID,
            joinedAt: serverTimestamp()
        }, { merge: true }).then(() => monitorQueue()).catch(e => console.log(e));
    }

    updateOtherUserTime(roomData.startTime);

    if (roomData.expireAt) {
        const leftSec = Math.max(0, (roomData.expireAt.toMillis() - Date.now()) / 1000);
        timeLeftDisplay.innerText = Math.ceil(leftSec) + "초";
        document.getElementById('timer-display').style.display = 'block';
    }
}

function monitorQueue() {
    const q = query(queueColRef, orderBy("joinedAt", "asc"));
    queueUnsubscribe = onSnapshot(q, (snapshot) => {
        const waitingList = [];
        snapshot.forEach((doc) => waitingList.push(doc.id));
        const myIndex = waitingList.indexOf(MY_ID);
        myRankDisplay.innerText = myIndex !== -1 ? (myIndex + 1) : "-";
    }, (error) => {
        if (error.message.includes("index")) {
            console.error("인덱스 필요: 콘솔 링크 확인");
        }
    });
}

function updateOtherUserTime(startTime) {
    if (otherUserTimerInterval) clearInterval(otherUserTimerInterval);
    if (!startTime) {
        currentUserTimeDisplay.innerText = "정보 없음";
        return;
    }
    otherUserTimerInterval = setInterval(() => {
        let startMillis = Date.now();
        if (startTime && typeof startTime.toMillis === 'function') {
            startMillis = startTime.toMillis();
        }
        const usedMillis = Date.now() - startMillis;
        if (usedMillis < 0) {
            currentUserTimeDisplay.innerText = "입장 중...";
            return;
        }
        const mins = Math.floor(usedMillis / 1000 / 60);
        const secs = Math.floor((usedMillis / 1000) % 60);
        currentUserTimeDisplay.innerText = `${mins}분 ${secs}초`;
    }, 1000);
}

async function removeFromQueue() {
    try { await deleteDoc(doc(queueColRef, MY_ID)); } catch (e) { }
}

function leaveRoom() {
    if (!confirm("정말 나가시겠습니까?")) return;
    amIInside = false;
    // 나가기 전에 마지막으로 그림 저장 (혹시 모르니)
    saveCanvasData();
    updateDoc(roomRef, { occupant: null, expireAt: null, startTime: null });
    location.reload();
}

// ==========================================
// 4. 메시지 기능 (유지)
// ==========================================
async function sendMessage() {
    const text = msgInput.value.trim();
    if (text.length === 0) return;
    try {
        await addDoc(collection(db, "world", "room1", "messages"), {
            text: text,
            author: "익명",
            createdAt: serverTimestamp()
        });
        msgInput.value = "";
        msgLog.scrollTop = msgLog.scrollHeight;
    } catch (e) { console.error(e); }
}

let unsubscribeMsg = null;
function subscribeMessages() {
    if (unsubscribeMsg) return;
    const q = query(collection(db, "world", "room1", "messages"), orderBy("createdAt", "asc"), limit(20));
    unsubscribeMsg = onSnapshot(q, (snapshot) => {
        msgLog.innerHTML = '';
        const welcome = document.createElement('div');
        welcome.className = 'msg-item system';
        welcome.innerText = "따뜻한 차 한 잔 마시며 쉬어가세요.";
        msgLog.appendChild(welcome);
        snapshot.forEach((doc) => {
            const d = doc.data();
            const div = document.createElement('div');
            div.className = 'msg-item';
            div.innerText = d.text;
            msgLog.appendChild(div);
        });
        msgLog.scrollTop = msgLog.scrollHeight;
    });
}

// ==========================================
// 5. [핵심] 캔버스 저장/로드 기능 추가
// ==========================================
let painting = false;

// 1) 그림 저장하기 (그릴 때마다, 혹은 붓을 뗄 때마다)
async function saveCanvasData() {
    if (!amIInside) return;
    // 캔버스를 이미지 데이터(긴 문자열)로 변환
    const dataUrl = canvas.toDataURL("image/png");

    try {
        // Firestore에 덮어쓰기 (merge: true)
        await setDoc(canvasRef, { image: dataUrl }, { merge: true });
        // console.log("그림 저장 완료");
    } catch (e) {
        console.error("그림 저장 실패:", e);
    }
}

// 2) 그림 불러오기 (입장 시 한 번)
async function loadCanvasData() {
    try {
        const docSnap = await getDoc(canvasRef);
        if (docSnap.exists() && docSnap.data().image) {
            const img = new Image();
            img.src = docSnap.data().image;
            img.onload = () => {
                // 이미지가 로드되면 캔버스에 그리기
                ctx.drawImage(img, 0, 0);
            };
            console.log("이전 흔적을 불러왔습니다.");
        }
    } catch (e) {
        console.error("그림 불러오기 실패:", e);
    }
}

function resizeCanvas() {
    const p = canvas.parentElement;
    if (!p) return;

    // 크기 조절 시 그림 유지 로직
    let temp = null;
    if (canvas.width > 0) { try { temp = canvas.toDataURL(); } catch (e) { } }

    canvas.width = p.clientWidth;
    canvas.height = p.clientHeight;

    if (temp) {
        const img = new Image();
        img.src = temp;
        img.onload = () => ctx.drawImage(img, 0, 0);
    }

    ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#5d4037';
}

function start(e) { painting = true; draw(e); }

// 붓을 뗄 때(mouseup) 마다 서버에 저장합니다.
function end() {
    painting = false;
    ctx.beginPath();
    // [중요] 한 획을 그을 때마다 저장 (실시간 공유 느낌)
    saveCanvasData();
}

function draw(e) {
    if (!painting) return;
    ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#5d4037';
    const r = canvas.getBoundingClientRect();
    ctx.lineTo(e.clientX - r.left, e.clientY - r.top);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(e.clientX - r.left, e.clientY - r.top);
}

canvas.addEventListener('mousedown', start);
canvas.addEventListener('mouseup', end);
canvas.addEventListener('mousemove', draw);
// 캔버스를 벗어나면 그림 끊기
canvas.addEventListener('mouseleave', () => { painting = false; ctx.beginPath(); });