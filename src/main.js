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
let myTimerInterval;      // 남은 시간(5분) 카운트다운
let heartbeatInterval;    // [NEW] 생존 신호 보내기 타이머
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

// [중요] 창 닫을 때 최대한 빨리 "나 나감" 처리 시도
window.addEventListener('beforeunload', () => {
    if (amIInside) {
        // 캔버스 저장 시도 (비동기라 보장되진 않음)
        saveCanvasData();
        // 방 비우기 (Navigator.sendBeacon 방식이 더 좋지만, Firestore 호환성을 위해 유지)
        updateDoc(roomRef, { occupant: null, expireAt: null, lastActive: null });
    }
    removeFromQueue();
});


// ==========================================
// 2. 방 감시 및 입장 로직 (심판)
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

    // 시간 계산
    const expireTimeMillis = data.expireAt ? data.expireAt.toMillis() : 0;
    const lastActiveMillis = data.lastActive ? data.lastActive.toMillis() : now;

    // [핵심 로직 변경]
    // 1. 방에 사람이 없거나 (occupant == null)
    // 2. 5분 시간이 다 됐거나 (expireTimeMillis < now)
    // 3. [NEW] 사람이 있는데 10초 이상 신호가 없거나 (잠수/강제종료)
    const isRoomEmpty = !data.occupant;
    const isTimeOver = expireTimeMillis < now;
    const isDead = (now - lastActiveMillis) > 10000; // 10초 딜레이 허용

    if (isRoomEmpty || isTimeOver || isDead) {
        // 내가 안에 있지 않은 상태라면 입장 시도
        if (!amIInside) tryEnterRoom();

        // 만약 내가 안에 있는데 시간이 다 된 거라면? (5분 컷)
        if (amIInside && isTimeOver) {
            alert("약속된 5분이 지났습니다. 다음 분을 위해 비워주세요.");
            leaveRoom(false); // confirm 없이 강제 퇴장
        }
    }
    else {
        // 누군가 정상적으로 사용 중
        if (data.occupant === MY_ID) {
            if (!amIInside) enterRoomMode(data.expireAt);
        } else {
            showQueueMode(data);
        }
    }
});

async function tryEnterRoom() {
    const nextExpire = new Date();
    nextExpire.setMinutes(nextExpire.getMinutes() + 5); // 5분 제한

    try {
        await updateDoc(roomRef, {
            occupant: MY_ID,
            expireAt: nextExpire,
            startTime: serverTimestamp(),
            lastActive: serverTimestamp() // [NEW] 입장 시 생존신호 시작
        });
        await removeFromQueue();
        console.log("방 입장 성공!");
    } catch (e) {
        // 동시 접속 시도 실패는 자연스러운 현상이므로 로그만 남김
        // console.log("입장 경쟁:", e);
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

    // [NEW] 생존 신호 보내기 (3초마다)
    // 창을 닫으면 이 인터벌이 멈추므로, 10초 뒤 lastActive가 갱신되지 않아 쫓겨남
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
        updateDoc(roomRef, { lastActive: serverTimestamp() }).catch(e => {
            console.log("신호 전송 실패(아마 쫓겨남)");
        });
    }, 3000);

    // 내 화면 타이머 (보여주기용)
    if (myTimerInterval) clearInterval(myTimerInterval);
    myTimerInterval = setInterval(() => {
        const left = expireTime.toMillis() - Date.now();
        if (left <= 0) {
            // 여기서 처리 안 해도 onSnapshot에서 처리하지만, UX를 위해 유지
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
        setDoc(myQueueRef, {
            userId: MY_ID,
            joinedAt: serverTimestamp()
        }, { merge: true }).then(() => monitorQueue()).catch(e => { });
    }

    updateOtherUserTime(roomData.startTime);

    if (roomData.expireAt) {
        const leftSec = Math.max(0, (roomData.expireAt.toMillis() - Date.now()) / 1000);
        timeLeftDisplay.innerText = Math.ceil(leftSec) + "초";
        document.getElementById('timer-display').style.display = 'block';
    }
}

// 대기열 로직
function monitorQueue() {
    const q = query(queueColRef, orderBy("joinedAt", "asc"));
    queueUnsubscribe = onSnapshot(q, (snapshot) => {
        const waitingList = [];
        snapshot.forEach((doc) => waitingList.push(doc.id));
        const myIndex = waitingList.indexOf(MY_ID);
        myRankDisplay.innerText = myIndex !== -1 ? (myIndex + 1) : "-";
    }, (error) => {
        if (error.message.includes("index")) console.error("인덱스 필요");
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
// [수정됨] 퇴장 처리 로직
// ==========================================
function leaveRoom(askConfirm = true) {
    if (askConfirm && !confirm("정말 나가시겠습니까?")) return;

    amIInside = false;
    // 타이머 해제
    if (heartbeatInterval) clearInterval(heartbeatInterval);

    saveCanvasData(); // 마지막 저장

    // 방 비우기
    updateDoc(roomRef, {
        occupant: null,
        expireAt: null,
        startTime: null,
        lastActive: null
    }).then(() => {
        // askConfirm이 false면(시간초과) 경고창 없이 바로 이동
        if (askConfirm) alert("안녕히 가세요.");

        window.close();
        history.back();
        setTimeout(() => { location.reload(); }, 1000);
    }).catch(() => {
        location.reload();
    });
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
// 5. 캔버스 로직 (유지)
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
    ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#5d4037';
}

function start(e) { painting = true; draw(e); }
function end() { painting = false; ctx.beginPath(); saveCanvasData(); }
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
canvas.addEventListener('mouseleave', () => { painting = false; ctx.beginPath(); });