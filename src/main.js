import { initializeApp } from "firebase/app";
import {
    getFirestore,
    doc,
    onSnapshot,
    updateDoc,
    setDoc,
    deleteDoc,
    addDoc,
    getDoc,
    collection,
    query,
    orderBy,
    limit,
    serverTimestamp
} from "firebase/firestore";

// ========================================================
// ▼▼▼ 본인의 Firebase 키값으로 꼭 교체해주세요 ▼▼▼
// ========================================================
const firebaseConfig = {
    apiKey: "AIzaSyAGopha4Zy2S9IHliTlFPEEprIyNFC8bsE",
    authDomain: "md1websiteproject.firebaseapp.com",
    projectId: "md1websiteproject",
    storageBucket: "md1websiteproject.firebasestorage.app",
    messagingSenderId: "427011802078",
    appId: "1:427011802078:web:920abac32165c01b62934f",
    measurementId: "G-CTT7KM6CEF"
};
// ========================================================

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// --- 전역 변수 ---
const MY_ID = 'guest_' + Math.random().toString(36).substr(2, 9);
console.log("나의 ID:", MY_ID);

let amIInside = false;
let myTimerInterval;
let heartbeatInterval;
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
leaveBtn.addEventListener('click', () => leaveRoom(true));
msgInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});
window.addEventListener('resize', resizeCanvas);

// 창 닫을 때
window.addEventListener('beforeunload', () => {
    if (amIInside) {
        saveCanvasData();
        updateDoc(roomRef, { occupant: null, expireAt: null, lastActive: null });
    }
    removeFromQueue();
});


// ==========================================
// 2. 방 감시 및 입장 로직
// ==========================================
const roomRef = doc(db, "world", "room1");
const queueColRef = collection(db, "world", "room1", "waiting");
const canvasRef = doc(db, "world", "canvas_data");

onSnapshot(roomRef, (snapshot) => {
    if (!snapshot.exists()) {
        setDoc(roomRef, { occupant: null, expireAt: null, lastActive: null });
        return;
    }

    const data = snapshot.data();
    const now = Date.now();
    const expireTimeMillis = data.expireAt ? data.expireAt.toMillis() : 0;
    const lastActiveMillis = data.lastActive ? data.lastActive.toMillis() : now;

    // 상태 체크 (방 비었음 or 시간초과 or 잠수)
    const isRoomEmpty = !data.occupant;
    const isTimeOver = expireTimeMillis < now;
    const isDead = (now - lastActiveMillis) > 10000;

    if (isRoomEmpty || isTimeOver || isDead) {
        if (!amIInside) tryEnterRoom();

        // 10분 시간 종료 시 강제 퇴장
        if (amIInside && isTimeOver) {
            alert("허락된 시간이 다 되었습니다. 평안히 돌아가십시오.");
            leaveRoom(false);
        }
    }
    else {
        if (data.occupant === MY_ID) {
            if (!amIInside) enterRoomMode(data.expireAt);
        } else {
            showQueueMode(data);
        }
    }
});

async function tryEnterRoom() {
    const nextExpire = new Date();
    // [설정] 제한 시간 10분
    nextExpire.setMinutes(nextExpire.getMinutes() + 10);

    try {
        await updateDoc(roomRef, {
            occupant: MY_ID,
            expireAt: nextExpire,
            startTime: serverTimestamp(),
            lastActive: serverTimestamp()
        });
        await removeFromQueue();
        console.log("고해소 입장");
    } catch (e) {
        // console.log("입장 경쟁 실패");
    }
}


// ==========================================
// 3. 화면 모드
// ==========================================

function enterRoomMode(expireTime) {
    amIInside = true;
    queueScreen.classList.add('hidden');
    roomScreen.classList.remove('hidden');

    if (queueUnsubscribe) { queueUnsubscribe(); queueUnsubscribe = null; }
    if (otherUserTimerInterval) clearInterval(otherUserTimerInterval);

    resizeCanvas();
    loadCanvasData();
    subscribeMessages();

    // 생존 신호 (3초마다)
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
        updateDoc(roomRef, { lastActive: serverTimestamp() }).catch(e => { });
    }, 3000);

    // 내 타이머
    if (myTimerInterval) clearInterval(myTimerInterval);
    myTimerInterval = setInterval(() => {
        const left = expireTime.toMillis() - Date.now();
        if (left <= 0) {
            document.getElementById('my-timer').innerText = "00:00";
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
        setDoc(myQueueRef, { userId: MY_ID, joinedAt: serverTimestamp() }, { merge: true })
            .then(() => monitorQueue()).catch(e => { });
    }

    updateOtherUserTime(roomData.startTime);

    if (roomData.expireAt) {
        const leftSec = Math.max(0, (roomData.expireAt.toMillis() - Date.now()) / 1000);
        // HTML 문구와 일치시킴
        queueMsg.innerHTML = `현재 고해가 진행 중입니다.<br>침묵 속에 차례를 기다리십시오.`;
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
        const mins = Math.floor(usedMillis / 1000 / 60);
        const secs = Math.floor((usedMillis / 1000) % 60);
        currentUserTimeDisplay.innerText = `${mins}분 ${secs}초`;
    }, 1000);
}

async function removeFromQueue() {
    try { await deleteDoc(doc(queueColRef, MY_ID)); } catch (e) { }
}

// ==========================================
// [퇴장 처리]
// ==========================================
function leaveRoom(askConfirm = true) {
    // 버튼 클릭 시 묻는 말
    if (askConfirm && !confirm("고해소를 떠나시겠습니까?")) return;

    amIInside = false;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    saveCanvasData();

    updateDoc(roomRef, {
        occupant: null, expireAt: null, startTime: null, lastActive: null
    }).then(() => {
        // 퇴장 완료 인사
        if (askConfirm) alert("당신의 마음에 평화가 깃들기를.");
        window.close();
        history.back();
        setTimeout(() => { location.reload(); }, 1000);
    }).catch(() => {
        location.reload();
    });
}

// ==========================================
// 4. 메시지 기능
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
    } catch (e) { }
}

let unsubscribeMsg = null;
function subscribeMessages() {
    if (unsubscribeMsg) return;
    const q = query(collection(db, "world", "room1", "messages"), orderBy("createdAt", "asc"), limit(20));
    unsubscribeMsg = onSnapshot(q, (snapshot) => {
        msgLog.innerHTML = '';
        const welcome = document.createElement('div');
        welcome.className = 'msg-item system';
        // 입장 환영 메시지
        welcome.innerText = "이곳은 고해의 공간입니다. 무거운 짐을 내려놓으십시오.";
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
// 5. 캔버스 로직 (백묵 스타일)
// ==========================================
let painting = false;

async function saveCanvasData() {
    if (!amIInside) return;
    const dataUrl = canvas.toDataURL("image/png");
    try { await setDoc(canvasRef, { image: dataUrl }, { merge: true }); } catch (e) { }
}

async function loadCanvasData() {
    try {
        const docSnap = await getDoc(canvasRef);
        if (docSnap.exists() && docSnap.data().image) {
            const img = new Image();
            img.src = docSnap.data().image;
            img.onload = () => { ctx.drawImage(img, 0, 0); };
        }
    } catch (e) { }
}

function resizeCanvas() {
    const p = canvas.parentElement;
    if (!p) return;
    let temp = null;
    if (canvas.width > 0) { try { temp = canvas.toDataURL(); } catch (e) { } }
    canvas.width = p.clientWidth;
    canvas.height = p.clientHeight;
    if (temp) {
        const img = new Image();
        img.src = temp;
        img.onload = () => ctx.drawImage(img, 0, 0);
    }
    // 펜 기본 스타일 (백묵)
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(220, 220, 220, 0.6)';
}

function start(e) { painting = true; draw(e); }
function end() { painting = false; ctx.beginPath(); saveCanvasData(); }
function draw(e) {
    if (!painting) return;

    // 펜 그리기 스타일 (백묵 질감)
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.shadowBlur = 2;
    ctx.shadowColor = 'rgba(255,255,255,0.3)';
    ctx.strokeStyle = 'rgba(230, 230, 230, 0.7)';

    const r = canvas.getBoundingClientRect();
    ctx.lineTo(e.clientX - r.left, e.clientY - r.top);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(e.clientX - r.left, e.clientY - r.top);
}

canvas.addEventListener('mousedown', start);
canvas.addEventListener('mouseup', end);
canvas.addEventListener('mousemove', draw);
canvas.addEventListener('mouseleave', () => { painting = false; ctx.beginPath(); });