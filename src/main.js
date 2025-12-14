// src/main.js
// 1. 설치된 firebase 라이브러리에서 가져오기
import { initializeApp } from "firebase/app";
import {
    getFirestore,
    doc,
    onSnapshot,
    updateDoc,
    setDoc,
    deleteDoc,
    addDoc,
    collection,
    query,
    orderBy,
    limit,
    serverTimestamp,
    getDocs
} from "firebase/firestore";

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
    apiKey: "AIzaSyAGopha4Zy2S9IHliTlFPEEprIyNFC8bsE",
    authDomain: "md1websiteproject.firebaseapp.com",
    projectId: "md1websiteproject",
    storageBucket: "md1websiteproject.firebasestorage.app",
    messagingSenderId: "427011802078",
    appId: "1:427011802078:web:920abac32165c01b62934f",
    measurementId: "G-CTT7KM6CEF"
};

// 앱 초기화
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// --- 전역 변수 ---
const MY_ID = 'guest_' + Math.random().toString(36).substr(2, 9);
let amIInside = false;
let myTimerInterval;
let otherUserTimerInterval; // 앞사람 사용 시간 타이머
let queueUnsubscribe = null; // 대기열 구독 취소용 함수

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

// 창을 닫거나 새로고침할 때 대기열에서 빠지기
window.addEventListener('beforeunload', () => {
    removeFromQueue();
});


// ==========================================
// 2. 방 감시 및 입장 로직 (핵심)
// ==========================================
const roomRef = doc(db, "world", "room1");
// 대기열 컬렉션 위치: world/room1/waiting
const queueColRef = collection(db, "world", "room1", "waiting");

onSnapshot(roomRef, (snapshot) => {
    if (!snapshot.exists()) {
        // 방이 처음 만들어지는 경우 초기화 (방이 비어있음)
        setDoc(roomRef, { occupant: null, expireAt: null });
        return;
    }

    const data = snapshot.data();
    const now = Date.now();

    // Firestore의 Timestamp를 밀리초로 변환 (데이터가 있을 때만)
    const expireTimeMillis = data.expireAt ? data.expireAt.toMillis() : 0;

    // A. 방이 비었거나, 시간이 만료됨
    if (!data.occupant || expireTimeMillis < now) {
        tryEnterRoom();
    }
    // B. 누군가 사용 중
    else {
        if (data.occupant === MY_ID) {
            // 나 자신이 주인
            if (!amIInside) enterRoomMode(data.expireAt);
        } else {
            // 다른 사람 있음 -> 대기 모드
            showQueueMode(data);
        }
    }
});

// 입장 시도
async function tryEnterRoom() {
    // 5분 뒤 시간 계산
    const nextExpire = new Date();
    nextExpire.setMinutes(nextExpire.getMinutes() + 5);

    try {
        // 1. 방 점유 시도 (startTime 추가)
        await updateDoc(roomRef, {
            occupant: MY_ID,
            expireAt: nextExpire,
            startTime: serverTimestamp() // 입장 시간 기록
        });

        // 2. 대기열에 내 이름이 있었다면 지우기
        await removeFromQueue();

    } catch (e) {
        console.log("입장 경쟁 실패:", e);
    }
}

// ==========================================
// 3. 화면 모드 (입장 vs 대기)
// ==========================================

function enterRoomMode(expireTime) {
    amIInside = true;
    queueScreen.classList.add('hidden');
    roomScreen.classList.remove('hidden');

    // 대기열 관련 리스너 해제
    if (queueUnsubscribe) {
        queueUnsubscribe();
        queueUnsubscribe = null;
    }
    if (otherUserTimerInterval) clearInterval(otherUserTimerInterval);

    resizeCanvas();
    subscribeMessages();

    // 내 남은 시간 타이머
    if (myTimerInterval) clearInterval(myTimerInterval);
    myTimerInterval = setInterval(() => {
        const left = expireTime.toMillis() - Date.now();
        if (left <= 0) {
            leaveRoom();
        } else {
            // 남은 시간 표시 (분:초)
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

    // 1. 대기열 등록 (이미 등록되어 있는지 확인하지 않고 setDoc으로 덮어쓰기하여 갱신)
    // 내 ID로 대기 문서를 만듭니다. (정렬을 위해 joinedAt 기록)
    const myQueueRef = doc(queueColRef, MY_ID);
    // 주의: 이미 대기 중인데 또 시간을 갱신하면 순서가 밀릴 수 있으므로,
    // 로컬 변수 등으로 체크하거나, Firestore 규칙이 필요하지만 
    // 여기선 간단히 "이전에 등록한 적 없으면 등록" 하는 식으로 처리 안하고
    // 계속 업데이트 되지 않게 한 번만 실행되도록 체크
    if (!queueUnsubscribe) {
        // 대기열에 나 추가 (없으면 생성)
        setDoc(myQueueRef, {
            userId: MY_ID,
            joinedAt: serverTimestamp()
        }, { merge: true }); // merge: true로 기존 시간 유지

        // 대기열 실시간 감시 시작
        monitorQueue();
    }

    // 2. 현재 사용자 사용 시간 계산 표시
    updateOtherUserTime(roomData.startTime);

    // 3. 남은 최대 시간 표시
    if (roomData.expireAt) {
        const leftSec = Math.max(0, (roomData.expireAt.toMillis() - Date.now()) / 1000);
        timeLeftDisplay.innerText = Math.ceil(leftSec) + "초";
        document.getElementById('timer-display').style.display = 'block';
    }
}

// 대기열 순서 확인 함수
function monitorQueue() {
    // 입장 시간 순으로 정렬
    const q = query(queueColRef, orderBy("joinedAt", "asc"));

    queueUnsubscribe = onSnapshot(q, (snapshot) => {
        const waitingList = [];
        snapshot.forEach((doc) => {
            waitingList.push(doc.id);
        });

        // 내 순서 찾기
        const myIndex = waitingList.indexOf(MY_ID);
        if (myIndex !== -1) {
            // 0번 인덱스가 1번째 순서
            myRankDisplay.innerText = (myIndex + 1);
        } else {
            myRankDisplay.innerText = "-";
        }
    });
}

// 앞사람 사용 시간 표시 타이머
function updateOtherUserTime(startTime) {
    if (otherUserTimerInterval) clearInterval(otherUserTimerInterval);

    if (!startTime) {
        currentUserTimeDisplay.innerText = "방금 입장";
        return;
    }

    otherUserTimerInterval = setInterval(() => {
        const startMillis = startTime.toMillis ? startTime.toMillis() : Date.now();
        const usedMillis = Date.now() - startMillis;

        const mins = Math.floor(usedMillis / 1000 / 60);
        const secs = Math.floor((usedMillis / 1000) % 60);

        currentUserTimeDisplay.innerText = `${mins}분 ${secs}초`;
    }, 1000);
}

// 대기열에서 삭제 (퇴장하거나 방에 들어갈 때)
async function removeFromQueue() {
    try {
        await deleteDoc(doc(queueColRef, MY_ID));
    } catch (e) {
        console.log(e);
    }
}

function leaveRoom() {
    if (!confirm("정말 나가시겠습니까?")) return;
    amIInside = false;

    // 방 비우기
    updateDoc(roomRef, { occupant: null, expireAt: null, startTime: null });
    location.reload();
}

// ==========================================
// 4. 메시지 및 캔버스 (기존 동일)
// ==========================================

// 메시지 기능
async function sendMessage() {
    const text = msgInput.value.trim();
    if (text.length === 0) return;
    try {
        await addDoc(collection(db, "world", "room1", "messages"), {
            text: text,
            author: "익명의 손님",
            createdAt: serverTimestamp()
        });
        msgInput.value = "";
        msgLog.scrollTop = msgLog.scrollHeight;
    } catch (e) {
        console.error(e);
        alert("메시지 전송 실패");
    }
}

let unsubscribeMsg = null;
function subscribeMessages() {
    if (unsubscribeMsg) return;
    const q = query(collection(db, "world", "room1", "messages"), orderBy("createdAt", "asc"), limit(20));
    unsubscribeMsg = onSnapshot(q, (snapshot) => {
        msgLog.innerHTML = '';
        const welcomeMsg = document.createElement('div');
        welcomeMsg.className = 'msg-item system';
        welcomeMsg.innerText = "따뜻한 차 한 잔 마시며 쉬어가세요.";
        msgLog.appendChild(welcomeMsg);
        snapshot.forEach((doc) => {
            const msg = doc.data();
            const div = document.createElement('div');
            div.className = 'msg-item';
            div.innerText = msg.text;
            msgLog.appendChild(div);
        });
        msgLog.scrollTop = msgLog.scrollHeight;
    });
}

// 캔버스 기능
let painting = false;

function resizeCanvas() {
    const parent = canvas.parentElement;
    if (!parent) return;
    let tempImage = null;
    if (canvas.width > 0 && canvas.height > 0) {
        try { tempImage = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch (e) { }
    }
    canvas.width = parent.clientWidth;
    canvas.height = parent.clientHeight;
    if (tempImage) ctx.putImageData(tempImage, 0, 0);

    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#5d4037';
}

function startPosition(e) { painting = true; draw(e); }
function finishedPosition() { painting = false; ctx.beginPath(); }
function draw(e) {
    if (!painting) return;

    // 연필 스타일 설정
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#5d4037';
    const rect = canvas.getBoundingClientRect();
    ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
}

// 마우스 이벤트 연결
canvas.addEventListener('mousedown', startPosition);
canvas.addEventListener('mouseup', finishedPosition);
canvas.addEventListener('mousemove', draw);

// (선택 사항) 터치 스크린 대응을 원하시면 touchstart, touchend, touchmove도 추가할 수 있습니다.