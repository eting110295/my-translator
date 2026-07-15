/* ============================================
   JavaScript 骨架：基本初始化 + API 健康檢查
   ============================================ */

console.log('app.js 已載入');

// 全域錯誤監聽器（幫助診斷瀏覽器端錯誤）
window.onerror = function(message, source, lineno, colno, error) {
    const errorMsg = `${message} (在 ${source}:${lineno}:${colno})`;
    console.error('GLOBAL ERROR:', errorMsg);
    let errDiv = document.getElementById('debugErrorBox');
    if (!errDiv) {
        errDiv = document.createElement('div');
        errDiv.id = 'debugErrorBox';
        errDiv.style.cssText = 'position:fixed;top:0;left:0;width:100%;background:#ff4d4d;color:white;padding:10px;z-index:9999;font-size:14px;text-align:center;word-break:break-all;font-weight:bold;box-shadow:0 2px 10px rgba(0,0,0,0.3);';
        document.body.appendChild(errDiv);
    }
    errDiv.textContent = 'JS 錯誤：' + errorMsg;
};

/* ============================================
   全局變量與設定載入
   ============================================ */
let langA, langB, result;

const cfg = {
    autospeak: true,
    rate: 1,
    geminikey: ''
};

// 從 LocalStorage 載入使用者設定
try {
    const savedCfg = localStorage.getItem('translator_cfg');
    if (savedCfg) {
        Object.assign(cfg, JSON.parse(savedCfg));
    }
} catch (e) {
    console.warn('載入設定失敗:', e);
}

const BCP = {
    'zh-TW': 'zh-TW',
    'en': 'en-US',
    'ja': 'ja-JP',
    'ko': 'ko-KR',
    'vi': 'vi-VN',
    'de': 'de-DE'
};

/* Web Speech API 設定 */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/* Helper Functions for Face-to-Face Mode */
const $ = (id) => document.getElementById(id);
const byId = (id) => ({ id, bcp: BCP[id] || 'en-US' });
const setResult = (el, text, isPlaceholder = false) => {
    if (!el) return;
    el.textContent = text;
    if (isPlaceholder) {
        el.classList.add('placeholder');
    } else {
        el.classList.remove('placeholder');
    }
};
const pushHistory = (srcText, transText) => {
    console.log('History:', srcText, '->', transText);
};

// OpenCC 簡轉繁轉換器
let _s2t = null, _s2tReady = false;
function toTraditional(text) {
    if (!text) return text;
    try {
        if (!_s2tReady) {
            _s2tReady = true;
            if (window.OpenCC) _s2t = window.OpenCC.Converter({ from: 'cn', to: 'tw' });
        }
        return _s2t ? _s2t(text) : text;
    } catch (e) { return text; }
}
function convForBcp(bcp, text) {
    return (bcp === 'zh-TW' || bcp === 'zh-HK') ? toTraditional(text) : text;
}

// 語音辨識器包裝類別 (供單人與面對面使用)
class Recognizer {
    constructor({ bcp, onInterim, onDone, onState }) {
        this.bcp = bcp; 
        this.onInterim = onInterim; 
        this.onDone = onDone; 
        this.onState = onState;
        this.active = false; 
        this.rec = null; 
        this.buffer = '';
    }
    start() {
        showDebugLog('Recognizer.start() called, bcp=' + this.bcp);
        if (!SpeechRecognition) { 
            showDebugLog('SpeechRecognition not supported in this browser');
            toast('此瀏覽器不支援語音辨識，請改用文字輸入'); 
            return; 
        }
        // 確保中止其他可能正在聽寫的辨識器，避免設備衝突
        if (typeof sRecognizer !== 'undefined' && sRecognizer && this !== sRecognizer && sRecognizer.active) {
            showDebugLog('Stopping active sRecognizer');
            try { sRecognizer.stop(); } catch(e){}
        }
        if (typeof recTop !== 'undefined' && recTop && this !== recTop && recTop.active) {
            showDebugLog('Stopping active recTop');
            try { recTop.stop(); } catch(e){}
        }
        if (typeof recBottom !== 'undefined' && recBottom && this !== recBottom && recBottom.active) {
            showDebugLog('Stopping active recBottom');
            try { recBottom.stop(); } catch(e){}
        }

        if (this.active) { 
            showDebugLog('Recognizer is already active, calling stop()');
            this.stop(); 
            return; 
        }
        this.buffer = '';
        const rec = new SpeechRecognition();
        rec.lang = this.bcp;
        rec.interimResults = true;
        rec.continuous = true;
        
        rec.onstart = () => {
            showDebugLog('SpeechRecognition.onstart fired');
        };
        
        rec.onresult = (e) => {
            showDebugLog('SpeechRecognition.onresult fired');
            let interim = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const r = e.results[i];
                if (r.isFinal) {
                    this.buffer += convForBcp(this.bcp, r[0].transcript);
                } else {
                    interim += convForBcp(this.bcp, r[0].transcript);
                }
            }
            const shown = (this.buffer + interim).trim();
            showDebugLog('Interim transcript: ' + shown);
            if (shown) this.onInterim?.(shown);
        };
        rec.onerror = (e) => {
            showDebugLog('SpeechRecognition.onerror fired: ' + e.error);
            if (e.error === 'no-speech' || e.error === 'aborted') return;
            if (e.error === 'not-allowed') {
                toast('麥克風權限被拒絕，請允許後重試');
            } else {
                toast('語音辨識錯誤：' + e.error);
            }
        };
        rec.onend = () => {
            showDebugLog('SpeechRecognition.onend fired, active=' + this.active);
            if (this.active) { 
                try { 
                    showDebugLog('restarting SpeechRecognition');
                    rec.start(); 
                } catch(err) {
                    showDebugLog('restart failed: ' + err.message);
                } 
            } else {
                this.onState?.(false);
            }
        };
        this.rec = rec;
        this.active = true;
        try { 
            rec.start(); 
            this.onState?.(true); 
            showDebugLog('rec.start() executed successfully');
        } catch (e) { 
            showDebugLog('rec.start() threw error: ' + e.message);
            toast('無法啟動麥克風'); 
            this.active = false; 
        }
    }
    stop() {
        showDebugLog('Recognizer.stop() called');
        this.active = false;
        if (this.rec) { 
            try { this.rec.stop(); } catch(e) { showDebugLog('rec.stop() err: ' + e.message); } 
        }
        this.onState?.(false);
        const text = this.buffer.trim();
        showDebugLog('Recognizer final text: ' + text);
        this.buffer = '';
        if (text) this.onDone?.(text);
    }
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

    // 初始化面對面模式
    initFaceMode();
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
   單人模式語音辨識初始化
   ============================================ */
let sRecognizer = null;

function initSingleRecognizer() {
    const micBtn = document.getElementById('micBtn');
    if (!micBtn) return;
    
    sRecognizer = new Recognizer({
        bcp: BCP[langA.value] || 'zh-TW',
        onInterim: (t) => {
            const inputText = document.getElementById('inputText');
            if (inputText) {
                inputText.value = t;
                const charCount = document.getElementById('charCount');
                if (charCount) charCount.textContent = `${t.length}/500`;
            }
        },
        onDone: async (t) => {
            const text = t.trim();
            if (!text) return;
            
            result.textContent = '翻譯中…';
            const ttsBtn = document.getElementById('ttsBtn');
            if (ttsBtn) ttsBtn.style.display = 'none';
            try {
                // 自動簡轉繁
                let finalText = text;
                if (langA.value === 'zh-TW') {
                    finalText = await convertSimplifiedToTraditional(text);
                    const inputText = document.getElementById('inputText');
                    if (inputText) inputText.value = finalText;
                }
                
                const out = await translate(finalText, NAME[langA.value], NAME[langB.value]);
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
        },
        onState: (on) => {
            micBtn.classList.toggle('recording', on);
            micBtn.style.opacity = on ? '0.6' : '1';
            const micLabel = micBtn.querySelector('.mic-label');
            if (micLabel) {
                micLabel.textContent = on ? '正在說話...（再點一下停止）' : '點一下開始說話';
            }
        }
    });
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
    
    // === 設定彈窗控制邏輯 ===
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsModal = document.getElementById('settingsModal');
    const closeBtn = settingsModal ? settingsModal.querySelector('.close-btn') : null;
    const saveSettings = document.getElementById('saveSettings');
    
    const cfgGeminiKey = document.getElementById('cfgGeminiKey');
    const cfgAutoSpeak = document.getElementById('cfgAutoSpeak');
    const cfgRate = document.getElementById('cfgRate');
    const cfgRateVal = document.getElementById('cfgRateVal');

    if (settingsBtn && settingsModal) {
        // 開啟設定
        settingsBtn.onclick = () => {
            if (cfgGeminiKey) cfgGeminiKey.value = cfg.geminikey || '';
            if (cfgAutoSpeak) cfgAutoSpeak.checked = cfg.autospeak;
            if (cfgRate) {
                cfgRate.value = cfg.rate;
                if (cfgRateVal) cfgRateVal.textContent = parseFloat(cfg.rate).toFixed(1);
            }
            settingsModal.style.display = 'flex';
        };

        // 關閉設定 (點叉叉)
        if (closeBtn) {
            closeBtn.onclick = () => {
                settingsModal.style.display = 'none';
            };
        }

        // 點擊彈窗外部關閉
        window.addEventListener('click', (e) => {
            if (e.target === settingsModal) {
                settingsModal.style.display = 'none';
            }
        });

        // 速度拉桿連動
        if (cfgRate && cfgRateVal) {
            cfgRate.oninput = (e) => {
                cfgRateVal.textContent = parseFloat(e.target.value).toFixed(1);
            };
        }

        // 儲存設定
        if (saveSettings) {
            saveSettings.onclick = () => {
                if (cfgGeminiKey) cfg.geminikey = cfgGeminiKey.value.trim();
                if (cfgAutoSpeak) cfg.autospeak = cfgAutoSpeak.checked;
                if (cfgRate) cfg.rate = parseFloat(cfgRate.value) || 1.0;

                try {
                    localStorage.setItem('translator_cfg', JSON.stringify(cfg));
                    console.log('設定已儲存:', cfg);
                } catch (e) {
                    console.error('儲存設定失敗:', e);
                }

                settingsModal.style.display = 'none';
                toast('設定已儲存！');
            };
        }
    }
    
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
        // 點擊麥克風按鈕開始聽寫
        micBtn.addEventListener('click', () => {
            ensureAudioUnlocked(); // 解鎖音訊
            const engine = document.querySelector('input[name=engine]:checked')?.value || 'sentence';
            if (engine === 'live') {
                toggleLive();
            } else {
                if (sRecognizer) {
                    sRecognizer.bcp = BCP[langA.value] || 'zh-TW';
                    sRecognizer.start();
                }
            }
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

/* =========================================================
   Gemini Live 即時模式 (socket 串流)
   ========================================================= */
let socket = null;
try {
    if (typeof io === 'function') {
        socket = io({ transports: ['websocket', 'polling'] });
        socket.on('connect', () => {
            const statusDot = document.getElementById('statusDot');
            if (statusDot) statusDot.classList.add('connected');
        });
        socket.on('disconnect', () => {
            const statusDot = document.getElementById('statusDot');
            if (statusDot) statusDot.classList.remove('connected');
            if (liveOn) stopLive();
        });
        socket.on('error', (d) => toast('伺服器：' + (d.msg || 'error')));
    } else {
        console.warn('socket.io 未載入，Gemini Live 即時模式停用');
    }
} catch (e) { console.warn('socket.io init 失敗', e); }

let liveOn = false, audioCtx, liveProcessor, liveInput, liveStream;
let livePending = '';
if (socket) {
    socket.on('text_response', (d) => {
        if (d.text) {
            livePending += d.text;
            result.textContent = livePending;
            result.classList.remove('placeholder');
        }
    });
    socket.on('turn_complete', () => {
        // 即時模式由 Gemini 直接吐語音（audio_response 播放），不需再用瀏覽器 TTS，避免雙重朗讀
        livePending = '';
    });
    socket.on('audio_response', (data) => {
        playLiveAudio(data);
    });
}

function toast(msg) {
    console.log('Toast:', msg);
    let t = document.querySelector('.toast-msg');
    if (!t) {
        t = document.createElement('div');
        t.className = 'toast-msg';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => {
        t.classList.remove('show');
    }, 2000);
}

async function toggleLive() { liveOn ? stopLive() : startLive(); }

async function startLive() {
    if (!socket) { toast('即時模式需要伺服器連線 (socket.io 未載入)'); return; }
    try {
        liveStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        liveInput = audioCtx.createMediaStreamSource(liveStream);
        liveProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
        liveInput.connect(liveProcessor);
        liveProcessor.connect(audioCtx.destination);
        const targetRate = 16000;
        liveProcessor.onaudioprocess = (e) => {
            if (!liveOn) return;
            const input = e.inputBuffer.getChannelData(0);
            const rate = audioCtx.sampleRate;
            const step = rate / targetRate;
            const len = Math.floor(input.length / step);
            const pcm = new Int16Array(len);
            for (let i = 0; i < len; i++) {
                let s = Math.max(-1, Math.min(1, input[Math.floor(i * step)] || 0));
                pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            if(liveOn) console.log('送出音訊 bytes:', pcm.buffer.byteLength);
            socket.emit('audio_in', pcm.buffer);
        };
        socket.emit('start_session', {
            langA: NAME[langA.value] || 'Traditional Chinese',
            langB: NAME[langB.value] || 'English',
            gemini_key: cfg.geminikey || '',
        });
        liveOn = true;
        toggleMic(document.getElementById('micBtn'), true);
        result.textContent = '即時聆聽中…';
        result.classList.add('placeholder');
    } catch (e) {
        toast('無法啟動麥克風：' + e.name);
        console.error(e);
    }
}

function stopLive() {
    liveOn = false;
    toggleMic(document.getElementById('micBtn'), false);
    if (liveProcessor) { liveProcessor.disconnect(); liveProcessor = null; }
    if (liveInput) { liveInput.disconnect(); liveInput = null; }
    if (liveStream) { liveStream.getTracks().forEach(t => t.stop()); liveStream = null; }
    if (socket) socket.emit('stop_session');
}

function toggleMic(btn, on) {
    if (!btn) return;
    btn.classList.toggle('recording', on);
    if (on) {
        btn.style.opacity = '0.6';
    } else {
        btn.style.opacity = '1';
    }
    const lbl = btn.querySelector('.mic-label');
    if (lbl) {
        lbl.textContent = on ? '即時模式：聆聽中...（再點一下停止）' : '點一下開始說話';
    }
}

/* =========================================================
   面對面模式
   ========================================================= */
function makeFaceSide(langSelId, resultBoxId, micBtnId, getTargetId) {
    const box = $(resultBoxId), btn = $(micBtnId);
    if (!box || !btn) return null;
    const rec = new Recognizer({
        bcp: BCP[$(langSelId).value] || 'en-US',
        onInterim: (t) => setResult(box, t, true),
        onDone: async (t) => {
            // 講完按停才會進來：麥克風已停，整段一次翻譯
            const src = $(langSelId).value, tgt = getTargetId();
            try {
                setResult(box, '翻譯中…', true);
                const out = await translate(t, NAME[src], NAME[tgt]);
                // 顯示在「對面那一側」的框
                const otherBox = (resultBoxId === 'f_resultBottom') ? $('f_resultTop') : $('f_resultBottom');
                setResult(otherBox, out);
                ensureAudioUnlocked();
                speak(out, BCP[tgt] || 'en-US', true);
                pushHistory(t, out);
            } catch (e) { toast(e.message); }
        },
        onState: (on) => {
            btn.classList.toggle('listening', on);
            btn.innerHTML = on ? '🔴 停止' : '🎤 說話';
        },
    });
    btn.addEventListener('click', () => { 
        ensureAudioUnlocked();
        rec.bcp = BCP[$(langSelId).value] || 'en-US'; 
        rec.start(); 
    });
    return rec;
}

// 宣告面對面對話物件
let recTop = null, recBottom = null;

function initFaceMode() {
    const fLangTop = $('f_langTop');
    const fLangBottom = $('f_langBottom');
    
    if (fLangTop) fill(fLangTop, cfg.f_langTop || 'en');
    if (fLangBottom) fill(fLangBottom, cfg.f_langBottom || 'zh-TW');

    recTop = makeFaceSide('f_langTop', 'f_resultTop', 'f_micTop', () => $('f_langBottom').value);
    recBottom = makeFaceSide('f_langBottom', 'f_resultBottom', 'f_micBottom', () => $('f_langTop').value);

    if (fLangTop) {
        fLangTop.addEventListener('change', () => { 
            cfg.f_langTop = fLangTop.value; 
            try { localStorage.setItem('translator_cfg', JSON.stringify(cfg)); } catch(e){} 
        });
    }
    if (fLangBottom) {
        fLangBottom.addEventListener('change', () => { 
            cfg.f_langBottom = fLangBottom.value; 
            try { localStorage.setItem('translator_cfg', JSON.stringify(cfg)); } catch(e){} 
        });
    }
}

/* =========================================================
   模式切換
   ========================================================= */
let mode = 'single';
const modeBtn = $('modeBtn');
if (modeBtn) {
    modeBtn.addEventListener('click', () => {
        if (liveOn) stopLive();
        if (recTop && recTop.active) recTop.stop();
        if (recBottom && recBottom.active) recBottom.stop();
        // 確保中斷單人語音辨識
        if (sRecognizer && sRecognizer.active) {
            try { sRecognizer.stop(); } catch(e){}
        }
        
        mode = mode === 'single' ? 'face' : 'single';
        $('singleView').classList.toggle('hidden', mode !== 'single');
        $('faceView').classList.toggle('hidden', mode !== 'face');
        modeBtn.textContent = mode === 'single' ? '👤 單人' : '👥 面對面';
    });
}
