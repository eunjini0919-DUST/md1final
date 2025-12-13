// src/main.js
// 1. 설치된 firebase 라이브러리에서 가져오기
import { initializeApp } from "firebase/app";
import {
    getFirestore,
    doc,
    onSnapshot,
    updateDoc,
    setDoc,
    serverTimestamp
} from "firebase/firestore";

// 2. Firebase 설정 (본인의 키로 꼭 교체해 주세요!)
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

// --- 전역 변수 및 상태 ---
const MY_ID = 'guest_' + Math.random().toString(36).substr(2, 9); // 'user' 대신 'guest'
let amIInside = false;
let myTimerInterval;

// DOM 요소 가져오기
const queueScreen = document.getElementById('queue-screen');
const roomScreen = document.getElementById('room-screen');
const queueMsg = document.getElementById('queue-msg');
const timeLeftDisplay = document.getElementById('time-left');
const canvas = document.getElementById('drawing-board');
const ctx = canvas.getContext('2d');

// 3. 방 상태 감시 (핵심 로직: 심판)
// 'world' 컬렉션의 'room1' 문서 하나를 계속 지켜봅니다.
const roomRef = doc(db, "world", "room1");

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

    // A. 방이 비었거나, 시간이 만료되었는가?
    if (!data.occupant || expireTimeMillis < now) {
        tryEnterRoom(); // 입장 시도
    }
    // B. 누군가 사용 중인가?
    else {
        if (data.occupant === MY_ID) {
            // 그 사람이 바로 '나'라면 -> 방 화면 보여주기
            if (!amIInside) enterRoomMode(data.expireAt);
        } else {
            // 다른 사람이라면 -> 대기 화면 보여주기
            showQueueMode(data.expireAt);
        }
    }
});

// 4. 입장 시도 함수
async function tryEnterRoom() {
    // 5분 뒤 시간 계산
    const nextExpire = new Date();
    nextExpire.setMinutes(nextExpire.getMinutes() + 5);

    try {
        // 내가 방 주인이라고 선언!
        await updateDoc(roomRef, {
            occupant: MY_ID,
            expireAt: nextExpire
        });
        // 성공하면 위 onSnapshot이 자동으로 감지해서 enterRoomMode를 실행시켜 줍니다.
    } catch (e) {
        console.log("아쉽게도 다른 분이 먼저 들어오셨네요.", e);
    }
}

// 5. 화면 모드 전환: 입장했을 때
function enterRoomMode(expireTime) {
    amIInside = true;
    queueScreen.classList.add('hidden');
    roomScreen.classList.remove('hidden');

    resizeCanvas(); // 캔버스 크기 맞춤

    // 내 타이머 시작
    if (myTimerInterval) clearInterval(myTimerInterval);
    myTimerInterval = setInterval(() => {
        const left = expireTime.toMillis() - Date.now();
        if (left <= 0) {
            leaveRoom(); // 시간 종료
        } else {
            // 남은 시간 표시 (분:초)
            const minutes = Math.floor(left / 1000 / 60);
            const seconds = Math.floor((left / 1000) % 60);
            document.getElementById('my-timer').innerText =
                `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
    }, 100);
}

// 6. 화면 모드 전환: 대기해야 할 때
function showQueueMode(expireTime) {
    amIInside = false;
    roomScreen.classList.add('hidden');
    queueScreen.classList.remove('hidden');

    if (expireTime) {
        const leftSec = Math.max(0, (expireTime.toMillis() - Date.now()) / 1000);

        // 따뜻한 대기 문구
        queueMsg.innerHTML = `지금은 누군가 온전히 휴식 중입니다.<br>잠시만 기다려 주세요.`;
        timeLeftDisplay.innerText = Math.ceil(leftSec) + "초";
        document.getElementById('timer-display').style.display = 'block';
    }
}

// 7. 퇴장 처리
function leaveRoom() {
    alert("휴식 시간이 끝났습니다. 편안한 시간 되셨나요?");
    amIInside = false;

    // 방 비우기 (다음 사람을 위해)
    updateDoc(roomRef, { occupant: null, expireAt: null });
    location.reload(); // 새로고침해서 다시 대기열 상태로
}

// --- 캔버스(그림판) 로직: 연필 느낌 ---
let painting = false;

function resizeCanvas() {
    const parent = canvas.parentElement;
    if (parent) {
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
    }
}
window.addEventListener('resize', resizeCanvas);

function startPosition(e) {
    painting = true;
    draw(e);
}
function finishedPosition() {
    painting = false;
    ctx.beginPath();
}
function draw(e) {
    if (!painting) return;

    // 연필 스타일 설정
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#5d4037'; // 진한 갈색 연필심

    // 좌표 계산 (캔버스 위치 기준)
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
}

// 마우스 이벤트 연결
canvas.addEventListener('mousedown', startPosition);
canvas.addEventListener('mouseup', finishedPosition);
canvas.addEventListener('mousemove', draw);

// (선택 사항) 터치 스크린 대응을 원하시면 touchstart, touchend, touchmove도 추가할 수 있습니다.