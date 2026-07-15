/* ============================================
   JavaScript 骨架：基本初始化 + API 健康檢查
   ============================================ */

console.log('app.js 已載入');

/* ============================================
   全局變量
   ============================================ */
let langA, langB, result;

const cfg = {
    autospeak: true,
    rate: 1,
    geminikey: ''
};

const BCP = {
    'zh-TW': 'zh-TW',
    'en': 'en-US',
    'ja': 'ja-JP',
    'ko': 'ko-KR',
    'vi': 'vi-VN',
    'de': 'de-DE'
};

/* Web Speech API 設定 */
let recognition;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
}

/* ============================================
   語言清單
   ============================================ */
const LANGS = [
    { id: 'zh-TW', label: '繁體中文' },
    { id: 'en', label: 'English' },
    { id: 'ja', label: '日本語' },
    { id: 'ko', label: '한국어' },
    { id: 'vi', label: 'Tiếng Việt' },
    { id: 'de', label: 'Deutsch' },
];

/* 語言代碼對應給模型看的名稱 */
const NAME = {
    'zh-TW': 'Traditional Chinese',
    'en': 'English',
    'ja': 'Japanese',
    'ko': 'Korean',
    'vi': 'Vietnamese',
    'de': 'German'
};

/* 填充語言下拉選單 */
function fill(sel, val) {
    sel.innerHTML = LANGS.map(l => `<option value="${l.id}">${l.label}</option>`).join('');
    sel.value = val;
}

/* ============================================
   1. 頁面載入時的初始化函式
   ============================================ */
function initApp() {
    console.log('應用初始化開始...');
    
    // 檢查後端健康狀態
    checkHealth();
    
    // 初始化事件監聽
    setupEventListeners();
}

/* ============================================
   2. API 健康檢查函式
   ============================================ */
function checkHealth() {
    console.log('正在檢查後端健康狀態...');
    
    fetch('/api/health')
        .then(response => response.json())
        .then(data => {
            console.log('✓ 後端健康狀態良好:', data);
            console.log('連線成功！可以開始使用翻譯功能。');
        })
        .catch(error => {
            console.error('✗ 無法連接到後端:', error);
            console.warn('請確保 Flask 伺服器正在執行（python app.py）');
        });
}

/* ============================================
   2. 翻譯函式
   ============================================ */
async function translate(text, source, target) {
    const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source, target })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    return data.translation;
}

/* ============================================
   語音辨識函式
   ============================================ */
function startListening() {
    if (!recognition) {
        alert('您的瀏覽器不支持語音識別');
        return;
    }
    
    // 如果已經在錄音，點擊則停止
    const micBtn = document.getElementById('micBtn');
    if (micBtn && micBtn.classList.contains('recording')) {
        recognition.stop();
        return;
    }
    
    // 自動設定語言
    const langCode = langA.value;
    const langMap = {
        'zh-TW': 'zh-TW',
        'en': 'en-US',
        'ja': 'ja-JP',
        'ko': 'ko-KR',
        'vi': 'vi-VN',
        'de': 'de-DE'
    };
    recognition.lang = langMap[langCode] || 'en-US';
    
    recognition.start();
}

function setupSpeechRecognition() {
    if (!recognition) return;
    
    const inputText = document.getElementById('inputText');
    const micBtn = document.getElementById('micBtn');
    
    recognition.onstart = () => {
        console.log('🎤 開始聽寫...');
        if (micBtn) {
            micBtn.classList.add('recording');
            micBtn.style.opacity = '0.6';
            const micLabel = micBtn.querySelector('.mic-label');
            if (micLabel) {
                micLabel.textContent = '正在說話...（再點一下停止）';
            }
        }
    };
    
    recognition.onresult = (event) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const current = event.results[i][0].transcript;
            transcript += current;
            if (event.results[i].isFinal) {
                console.log('✓ 最終結果:', current);
            }
        }
        if (inputText && transcript) {
            inputText.value = transcript;
            const charCount = document.getElementById('charCount');
            if (charCount) {
                charCount.textContent = inputText.value.length + '/500';
            }
        }
    };
    
    recognition.onerror = (event) => {
        console.error('❌ 語音識別錯誤:', event.error);
        alert('聽寫失敗：' + event.error);
    };
    
    recognition.onend = async () => {
        console.log('🎤 聽寫結束');
        if (micBtn) {
            micBtn.classList.remove('recording');
            micBtn.style.opacity = '1';
            const micLabel = micBtn.querySelector('.mic-label');
            if (micLabel) {
                micLabel.textContent = '點一下開始說話';
            }
        }
        
        const text = inputText.value.trim();
        if (!text) return;
        
        result.textContent = '翻譯中…';
        const ttsBtn = document.getElementById('ttsBtn');
        if (ttsBtn) ttsBtn.style.display = 'none';
        
        try {
            // 自動簡轉繁
            let finalText = text;
            if (langA.value === 'zh-TW') {
                finalText = await convertSimplifiedToTraditional(text);
                inputText.value = finalText;
            }
            
            const out = await translate(finalText, NAME[langA.value], NAME[langB.value]);
            result.textContent = out;
            
            // 顯示朗讀按鈕並開始自動播放
            if (ttsBtn) {
                ttsBtn.style.display = 'flex';
                ttsBtn.innerHTML = '■ 停止';
                speak(out, BCP[langB.value] || 'en-US', false, () => {
                    ttsBtn.innerHTML = '🔊 朗讀';
                });
            } else {
                speak(out, BCP[langB.value] || 'en-US');
            }
        } catch (e) {
            result.textContent = '（翻譯失敗）';
            alert(e.message);
        }
    };
}

/* ============================================
   3. 事件監聽器設定
   ============================================ */
function setupEventListeners() {
    // 取得全域元素
    langA = document.getElementById('langA');
    langB = document.getElementById('langB');
    result = document.getElementById('result');
    
    if (langA) fill(langA, 'zh-TW');
    if (langB) fill(langB, 'en');
    
    // 文字輸入 - 更新字數
    const inputText = document.getElementById('inputText');
    const charCount = document.getElementById('charCount');
    
    if (inputText && charCount) {
        inputText.addEventListener('input', (e) => {
            const length = e.target.value.length;
            charCount.textContent = length + '/500';
        });
    }
    
    // 對調語言
    document.getElementById('swap').onclick = () => {
        const a = langA.value; 
        langA.value = langB.value; 
        langB.value = a;
    };
    
    // 翻譯鈕 - 呼叫後端翻譯 API
    const ttsBtn = document.getElementById('ttsBtn');
    document.getElementById('send').onclick = async () => {
        const text = document.getElementById('inputText').value.trim();
        if (!text) return;
        
        ensureAudioUnlocked(); // 解鎖音訊
        result.textContent = '翻譯中…';
        if (ttsBtn) ttsBtn.style.display = 'none';
        try {
            const out = await translate(text, NAME[langA.value], NAME[langB.value]);
            result.textContent = out;
            
            // 語音朗讀與按鈕連動
            if (ttsBtn) {
                ttsBtn.style.display = 'flex';
                ttsBtn.innerHTML = '■ 停止';
                speak(out, BCP[langB.value] || 'en-US', false, () => {
                    ttsBtn.innerHTML = '🔊 朗讀';
                });
            } else {
                speak(out, BCP[langB.value] || 'en-US');
            }
        } catch (e) {
            result.textContent = '（翻譯失敗）';
            alert(e.message);
        }
    };
    
    // 朗讀/停止按鈕
    if (ttsBtn) {
        ttsBtn.onclick = () => {
            ensureAudioUnlocked();
            const text = result.textContent.trim();
            if (!text || text === '翻譯中…' || text === '（翻譯失敗）') return;
            
            if (ttsBtn.innerHTML.includes('停止')) {
                stopAllAudio();
                ttsBtn.innerHTML = '🔊 朗讀';
            } else {
                ttsBtn.innerHTML = '■ 停止';
                speak(text, BCP[langB.value] || 'en-US', true, () => {
                    ttsBtn.innerHTML = '🔊 朗讀';
                });
            }
        };
    }
    
    // 麥克風按鈕 - 語音輸入
    const micBtn = document.getElementById('micBtn');
    if (micBtn && SpeechRecognition) {
        // 初始化語音識別
        setupSpeechRecognition();
        
        // 點擊麥克風按鈕開始聽寫
        micBtn.addEventListener('click', () => {
            ensureAudioUnlocked(); // 解鎖音訊
            startListening();
        });
    } else if (micBtn && !SpeechRecognition) {
        micBtn.style.opacity = '0.5';
        micBtn.title = '您的瀏覽器不支持語音識別';
    }
}

/* ============================================
   TTS (語音朗讀) 功能
   ============================================ */
const synth = window.speechSynthesis;

// 瀏覽器內建朗讀（依賴手機語音包）；onEnd 於念完或出錯時回呼
function browserSpeak(text, bcp, onEnd = null) {
    if (!synth || !text) { onEnd?.(); return; }
    try {
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = bcp;
        u.rate = parseFloat(cfg.rate) || 1;
        const voices = synth.getVoices();
        const prefix = bcp.split('-')[0];
        const v = voices.find(x => x.lang === bcp) || voices.find(x => x.lang.startsWith(prefix));
        if (v) u.voice = v;
        u.onend = () => onEnd?.();
        u.onerror = () => onEnd?.();
        synth.speak(u);
    } catch (e) { console.warn('TTS error', e); onEnd?.(); }
}

// 主朗讀：優先用雲端 Gemini TTS（任何語言都有聲音，免裝手機語音包），失敗才用瀏覽器
// force=true 無視自動朗讀設定（手動朗讀鈕）；onEnd 於播放結束回呼（供「停止」鈕重置狀態）
async function speak(text, bcp, force = false, onEnd = null) {
    if ((!cfg.autospeak && !force) || !text) { onEnd?.(); return; }
    // 先中斷前一句尚在播放或排隊的語音，確保只念最新這一句。
    // 否則雲端 TTS 會依 nextTime 一段段往後排，把之前累積的語音接連重播，聽起來像重複、延遲。
    stopAllAudio();
    try {
        const res = await fetch('/api/tts', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, gemini_key: cfg.geminikey || '' })
        });
        if (res.ok) {
            const buf = await res.arrayBuffer();
            if (buf && buf.byteLength > 44) { onAllAudioEnd = onEnd; playLiveAudio(buf); return; }
        }
    } catch (e) { console.warn('雲端 TTS 失敗，改用瀏覽器', e); }
    browserSpeak(text, bcp, onEnd);   // 後備
}

// 在使用者點擊當下解鎖音訊（手機／iOS 要求音訊須由手勢啟動，否則靜音）
function ensureAudioUnlocked() {
    try {
        if (!playCtx) playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
        if (playCtx.state === 'suspended') playCtx.resume();
    } catch (e) { /* ignore */ }
}

// 停止所有朗讀（雲端 Web Audio + 瀏覽器 TTS）
function stopAllAudio() {
    audioSources.forEach(s => { try { s.onended = null; s.stop(); } catch (e) {} });
    audioSources = [];
    nextTime = 0;
    if (synth) { try { synth.cancel(); } catch (e) {} }
    const cb = onAllAudioEnd; onAllAudioEnd = null; cb?.();
}
if (synth) synth.onvoiceschanged = () => synth.getVoices();

// 播放 Gemini Live 原生語音 (24kHz PCM 16-bit)
let playCtx = null, nextTime = 0;
let audioSources = [];      // 進行中的 Web Audio 節點（供停止用）
let onAllAudioEnd = null;   // 全部播放結束時的回呼（供「停止」鈕重置狀態）
function playLiveAudio(data) {
    try {
        if (!playCtx) playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
        if (playCtx.state === 'suspended') playCtx.resume();   // 手機須解鎖後才有聲音
        const int16 = new Int16Array(data);
        const f32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
        const buf = playCtx.createBuffer(1, f32.length, 24000);
        buf.getChannelData(0).set(f32);
        const src = playCtx.createBufferSource();
        src.buffer = buf; src.connect(playCtx.destination);
        const now = playCtx.currentTime;
        if (nextTime < now) nextTime = now;
        src.start(nextTime); nextTime += buf.duration;
        audioSources.push(src);
        src.onended = () => {
            audioSources = audioSources.filter(s => s !== src);
            if (audioSources.length === 0) { const cb = onAllAudioEnd; onAllAudioEnd = null; cb?.(); }
        };
    } catch (e) { console.warn('play audio error', e); }
}


/* ============================================
   4. 簡中轉繁中（簡轉繁）修正
   ============================================ */
async function convertSimplifiedToTraditional(text) {
    try {
        const out = await translate(text, 'Simplified Chinese', 'Traditional Chinese');
        return out;
    } catch (e) {
        console.warn('簡轉繁失敗:', e.message);
        return text; // 失敗時返回原文
    }
}

/* ============================================
   5. 頁面載入完成時執行初始化
   ============================================ */
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM 內容已完全載入');
    initApp();
});

// 備用：如果 DOMContentLoaded 已經觸發過了
if (document.readyState === 'loading') {
    // DOM 還在載入中
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    // DOM 已經載入完了
    initApp();
}
