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

// 全域 Debug 日誌顯示（幫助動態了解瀏覽器端運行狀態）
function showDebugLog(msg) {
    console.log('[DEBUG LOG]:', msg);
    let logDiv = document.getElementById('debugLogBox');
    if (!logDiv) {
        logDiv = document.createElement('div');
        logDiv.id = 'debugLogBox';
        logDiv.style.cssText = 'position:fixed;bottom:10px;right:10px;width:300px;max-height:200px;overflow-y:auto;background:rgba(0,0,0,0.85);color:#00ff00;padding:10px;z-index:9999;font-size:11px;font-family:monospace;border-radius:5px;border:1px solid #00ff00;word-break:break-all;';
        document.body.appendChild(logDiv);
    }
    const p = document.createElement('p');
    p.style.margin = '2px 0';
    p.textContent = new Date().toLocaleTimeString() + ': ' + msg;
    logDiv.appendChild(p);
    logDiv.scrollTop = logDiv.scrollHeight;
}

/* ============================================
   全局變量與設定載入
   ============================================ */
let langA, langB, result;

const cfg = {
    autospeak: true,
    rate: 1,
    geminikey: '',
    tavilykey: '',
    s_langA: 'zh-TW',
    s_langB: 'en',
    theme: 'ocean'
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
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/* Helper Functions for Face-to-Face Mode */
const $ = (id) => document.getElementById(id);
const byId = (id) => ({ id, bcp: BCP[id] || 'en-US', name: NAME[id] || 'English' });
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
    try {
        if (!srcText || !transText) return;
        const historyData = JSON.parse(localStorage.getItem('sweety_translate_history') || '[]');
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        historyData.unshift({ srcText, transText, time: timeStr });
        if (historyData.length > 20) historyData.pop();
        localStorage.setItem('sweety_translate_history', JSON.stringify(historyData));
        renderHistory();
    } catch (e) {
        console.error('Save history failed:', e);
    }
};

function renderHistory() {
    const listEl = document.getElementById('historyList');
    if (!listEl) return;
    try {
        const historyData = JSON.parse(localStorage.getItem('sweety_translate_history') || '[]');
        if (historyData.length === 0) {
            listEl.innerHTML = '<div class="history-item empty">尚無翻譯紀錄</div>';
            return;
        }
        listEl.innerHTML = historyData.map((item, idx) => `
            <div class="history-item" onclick="loadHistoryItem(${idx})">
                <div class="history-item-text">${escapeHtml(item.srcText)}</div>
                <div class="history-item-time">${item.time} &gt;</div>
            </div>
        `).join('');
    } catch (e) {
        console.error('Render history failed:', e);
    }
}

function loadHistoryItem(idx) {
    try {
        const historyData = JSON.parse(localStorage.getItem('sweety_translate_history') || '[]');
        if (idx >= 0 && idx < historyData.length) {
            const item = historyData[idx];
            document.getElementById('inputText').value = item.srcText;
            document.getElementById('result').textContent = item.transText;
            document.getElementById('result').classList.remove('placeholder');
            const ttsBtn = document.getElementById('ttsBtn');
            if (ttsBtn) ttsBtn.style.display = 'flex';
            
            // update char count
            const charCount = document.getElementById('charCount');
            if (charCount) charCount.textContent = item.srcText.length + '/500';
        }
    } catch (e) {}
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

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
        rec.continuous = false; // 設為 false，讓瀏覽器自動偵測說話停頓
        
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
            if (e.error === 'no-speech') return;
            this.active = false;
            if (e.error === 'aborted') {
                showDebugLog('SpeechRecognition aborted.');
            } else if (e.error === 'not-allowed') {
                toast('麥克風權限被拒絕，請允許後重試');
            } else {
                toast('語音辨識錯誤：' + e.error);
            }
        };
        rec.onend = () => {
            showDebugLog('SpeechRecognition.onend fired, active=' + this.active);
            if (this.active) { 
                // 說話停頓後自動停止並觸發翻譯
                this.stop();
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
    { id: 'ko', label: '韓國語' },
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
let appInitialized = false;
function initApp() {
    if (appInitialized) return;
    appInitialized = true;
    console.log('應用初始化開始...');
    
    // 檢查後端健康狀態
    checkHealth();
    
    // 初始化事件監聽
    setupEventListeners();

    // 渲染歷史記錄
    renderHistory();

    // 初始化單人語音辨識
    initSingleRecognizer();

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
    
    if (langA) fill(langA, cfg.s_langA || 'zh-TW');
    if (langB) fill(langB, cfg.s_langB || 'en');
    
    // === 切換單人/面對面模式 ===
    const modeSingle = document.getElementById('modeSingle');
    const modeDouble = document.getElementById('modeDouble');
    const singleView = document.getElementById('singleView');
    const faceView = document.getElementById('faceView');
    if (modeSingle && modeDouble && singleView && faceView) {
        const toggleMode = (toFace) => {
            if (toFace) {
                singleView.classList.add('hidden');
                faceView.classList.remove('hidden');
                modeDouble.classList.add('active');
                modeSingle.classList.remove('active');
            } else {
                faceView.classList.add('hidden');
                singleView.classList.remove('hidden');
                modeSingle.classList.add('active');
                modeDouble.classList.remove('active');
            }
        };
        modeSingle.onclick = () => toggleMode(false);
        modeDouble.onclick = () => toggleMode(true);
    }
    
    // === 設定彈窗控制邏輯 ===
    // === 設定彈窗控制邏輯 ===
    initSettingsEvents();
    
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
        cfg.s_langA = langA.value;
        cfg.s_langB = langB.value;
        try { localStorage.setItem('translator_cfg', JSON.stringify(cfg)); } catch(e){}
    };

    if (langA) {
        langA.addEventListener('change', () => {
            cfg.s_langA = langA.value;
            try { localStorage.setItem('translator_cfg', JSON.stringify(cfg)); } catch(e){}
        });
    }
    if (langB) {
        langB.addEventListener('change', () => {
            cfg.s_langB = langB.value;
            try { localStorage.setItem('translator_cfg', JSON.stringify(cfg)); } catch(e){}
        });
    }
    
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
            
            // 儲存至歷史紀錄
            pushHistory(text, out);
            
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

    // 複製按鈕
    const copyBtn = document.getElementById('copyBtn');
    if (copyBtn) {
        copyBtn.onclick = () => {
            const text = result.textContent.trim();
            if (!text || text === '翻譯結果會顯示在這裡…' || text === '（翻譯失敗）') {
                toast('無翻譯結果可複製');
                return;
            }
            navigator.clipboard.writeText(text).then(() => {
                toast('已複製到剪貼簿！');
            }).catch(err => {
                console.error('Copy failed:', err);
            });
        };
    }

    // 收藏按鈕
    const favBtn = document.getElementById('favBtn');
    if (favBtn) {
        favBtn.onclick = () => {
            const text = result.textContent.trim();
            if (!text || text === '翻譯結果會顯示在這裡…' || text === '（翻譯失敗）') {
                toast('無翻譯結果可收藏');
                return;
            }
            toast('已加入收藏！');
        };
    }

    // 清除歷史記錄按鈕
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');
    if (clearHistoryBtn) {
        clearHistoryBtn.onclick = () => {
            localStorage.removeItem('sweety_translate_history');
            renderHistory();
            toast('已清除歷史紀錄');
        };
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


async function convertSimplifiedToTraditional(text) {
    return toTraditional(text);
}


// ===== 9. 設定面板 / 密碼 / 換風格 =====

// 步驟一：設定資料庫讀寫與預設值
const DEFAULT_CFG = {
    autospeak: true,
    rate: 1.0,
    geminikey: '',
    tavilykey: '',
    owmkey: '',
    s_langA: 'zh-TW',
    s_langB: 'en',
    theme: 'ocean'
};

function loadCfg() {
    try {
        return { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem('translator_cfg') || '{}') };
    } catch(e) {
        return { ...DEFAULT_CFG };
    }
}

function saveCfg(c) {
    try {
        localStorage.setItem('translator_cfg', JSON.stringify(c));
    } catch(e) {
        console.error('儲存設定失敗:', e);
    }
}

// 覆蓋全域 cfg 的預設載入與設定
Object.assign(cfg, loadCfg());

// 步驟三：打開設定與儲存邏輯
function openSettings() {
    const cfgGeminiKey = document.getElementById('cfgGeminiKey');
    const cfgOwmKey = document.getElementById('cfgOwmKey');
    const cfgTavilyKey = document.getElementById('cfgTavilyKey');
    const cfgAutoSpeak = document.getElementById('cfgAutoSpeak');
    const cfgRate = document.getElementById('cfgRate');
    const cfgRateVal = document.getElementById('cfgRateVal');
    const cfgTheme = document.getElementById('cfgTheme');
    const settingsModal = document.getElementById('settingsModal');

    if (cfgGeminiKey) cfgGeminiKey.value = cfg.geminikey || '';
    if (cfgOwmKey) cfgOwmKey.value = cfg.owmkey || '';
    if (cfgTavilyKey) cfgTavilyKey.value = cfg.tavilykey || '';
    if (cfgAutoSpeak) cfgAutoSpeak.checked = cfg.autospeak;
    if (cfgTheme) cfgTheme.value = cfg.theme || 'purple';
    if (cfgRate) {
        cfgRate.value = cfg.rate;
        if (cfgRateVal) cfgRateVal.textContent = parseFloat(cfg.rate).toFixed(1);
    }
    
    history.pushState({ modal: 'settings' }, '');
    if (settingsModal) settingsModal.style.display = 'flex';
}

function saveSettingsLogic() {
    const cfgGeminiKey = document.getElementById('cfgGeminiKey');
    const cfgOwmKey = document.getElementById('cfgOwmKey');
    const cfgTavilyKey = document.getElementById('cfgTavilyKey');
    const cfgAutoSpeak = document.getElementById('cfgAutoSpeak');
    const cfgRate = document.getElementById('cfgRate');
    const cfgTheme = document.getElementById('cfgTheme');
    const settingsModal = document.getElementById('settingsModal');

    if (cfgGeminiKey) cfg.geminikey = cfgGeminiKey.value.trim();
    if (cfgOwmKey) cfg.owmkey = cfgOwmKey.value.trim();
    if (cfgTavilyKey) cfg.tavilykey = cfgTavilyKey.value.trim();
    if (cfgAutoSpeak) cfg.autospeak = cfgAutoSpeak.checked;
    if (cfgRate) cfg.rate = parseFloat(cfgRate.value) || 1.0;
    if (cfgTheme) cfg.theme = cfgTheme.value;

    applyTheme(cfg.theme); // 步驟五
    saveCfg(cfg);          // 步驟一

    if (settingsModal) {
        settingsModal.style.display = 'none';
    }
    if (history.state && history.state.modal === 'settings') {
        history.back();
    }
    toast('設定已儲存！');
}

// 步驟五：讓下拉選單真的換色
function applyTheme(t) {
    document.body.dataset.theme = t || 'purple';
}

function initSettingsEvents() {
    const settingsBtn = document.getElementById('settingsBtn');
    const saveSettings = document.getElementById('saveSettings');
    const settingsModal = document.getElementById('settingsModal');
    const closeBtn = settingsModal ? settingsModal.querySelector('.close-btn') : null;
    const cfgTheme = document.getElementById('cfgTheme');
    const cfgRate = document.getElementById('cfgRate');
    const cfgRateVal = document.getElementById('cfgRateVal');

    if (settingsBtn) settingsBtn.onclick = openSettings;
    if (saveSettings) saveSettings.onclick = saveSettingsLogic;

    const closeSettings = () => {
        applyTheme(cfg.theme); // 還原成已儲存的主題（撤銷即時預覽）
        if (settingsModal) settingsModal.style.display = 'none';
        if (history.state && history.state.modal === 'settings') {
            history.back();
        }
    };

    if (closeBtn) closeBtn.onclick = closeSettings;
    window.addEventListener('click', (e) => {
        if (e.target === settingsModal) closeSettings();
    });

    if (cfgTheme) {
        cfgTheme.addEventListener('change', () => {
            applyTheme(cfgTheme.value);
        });
    }

    if (cfgRate && cfgRateVal) {
        cfgRate.oninput = (e) => {
            cfgRateVal.textContent = parseFloat(e.target.value).toFixed(1);
        };
    }

    // 開機時套用已儲存的主題配色
    applyTheme(cfg.theme);
}


// ===== 10. 啟動 =====
// 優先使用 DOMContentLoaded
document.addEventListener('DOMContentLoaded', initApp);

// 備用：如果 DOMContentLoaded 已經觸發過了
if (document.readyState !== 'loading') {
    initApp();
}

// 註冊 Service Worker (PWA)
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(e => console.warn('SW 註冊失敗', e));
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
                setResult(box, t); // 還原說話者的原文顯示
                ensureAudioUnlocked();
                speak(out, BCP[tgt] || 'en-US', true);
                pushHistory(t, out);
            } catch (e) {
                setResult(box, t); // 失敗時也還原原文
                toast(e.message);
            }
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

// ===== 7. 拍照 / 檔案 =====
function providerBody() {
    return {
        provider: 'gemini',
        base_url: '',
        api_key: cfg.geminikey || '',
        model: ''
    };
}

// 相機影像 client 端縮圖：省流量、加速雲端辨識（Gemini 最佳邊長約 1568px）
function fileToDownscaledDataURL(file, maxDim = 1568, quality = 0.85) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
            const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('圖片讀取失敗')); };
        img.src = url;
    });
}
function dataURLToBlob(dataURL) {
    const [head, b64] = dataURL.split(',');
    const mime = (head.match(/data:(.*?);/) || [, 'image/jpeg'])[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

let currentVisionDataURL = '';

function openVision(title) {
    stopAllAudio(); setVisionSpeakBtn(false);   // 開新的一張前，先停掉上一段朗讀
    if ($('vision_target') && $('langB')) {
        // 同步主畫面的目標翻譯語言，這樣就不會預設只能翻譯為繁中
        $('vision_target').value = $('langB').value;
    }
    $('visionTitle').textContent = title;
    $('visionResult').classList.add('hidden');
    $('visionSummary').textContent = '';
    $('visionTranslation').textContent = '';
    $('visionStatus').textContent = '';
    const prev = $('visionPreview'); prev.classList.add('hidden'); prev.innerHTML = '';
    lastVisionText = '';
    currentVisionDataURL = '';
    history.pushState({ modal: 'vision' }, '');
    visionModal.classList.remove('hidden');
}
function renderVision(result) {
    $('visionStatus').textContent = result.note ? ('ℹ️ ' + result.note) : '';
    const summary = (result.summary || '').trim();
    const translation = (result.translation || '').trim();
    $('visionSummary').textContent = summary || '（無摘要）';
    $('visionTranslation').textContent = translation || '（無可翻譯文字）';
    $('visionResult').classList.remove('hidden');
    lastVisionText = translation || summary;
    if (translation || summary) {
        pushHistory('（拍照／檔案）', (summary ? summary + '\n' : '') + translation);
    }
}


// --- 相機拍照 ---
if ($('s_camera')) {
    $('s_camera').addEventListener('click', () => $('cameraInput').click());
}
if ($('cameraInput')) {
    $('cameraInput').addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';                         // 允許再次拍同一來源
        if (!file) return;
        openVision('📷 拍照翻譯');
        try {
            $('visionStatus').textContent = '影像處理中…';
            const dataURL = await fileToDownscaledDataURL(file);
            currentVisionDataURL = dataURL;
            $('visionPreview').innerHTML = `<img src="${dataURL}" alt="preview" style="max-width: 100%; max-height: 300px; border-radius: 5px;">`;
            $('visionPreview').classList.remove('hidden');
            $('visionStatus').textContent = '雲端辨識與翻譯中…（約數秒）';
            const target = byId($('vision_target').value).name;
            const res = await fetch('/api/vision', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: dataURL, target, ...providerBody() }),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || '辨識失敗');
            renderVision(data);
        } catch (err) { $('visionStatus').textContent = '❌ ' + err.message; toast(err.message); }
    });
}

// 支援在彈窗內直接切換目標語言，即時重新翻譯同一張照片
if ($('vision_target')) {
    $('vision_target').addEventListener('change', async () => {
        if (!currentVisionDataURL) return;
        try {
            $('visionStatus').textContent = '重新翻譯中…（約數秒）';
            $('visionResult').classList.add('hidden');
            const target = byId($('vision_target').value).name;
            const res = await fetch('/api/vision', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: currentVisionDataURL, target, ...providerBody() }),
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || '翻譯失敗');
            renderVision(data);
        } catch (err) { $('visionStatus').textContent = '❌ ' + err.message; toast(err.message); }
    });
}


// 朗讀鈕：可切換 —— 沒在念就開始念，念的過程中變「⏹ 停止」，可隨時中斷
let visionSpeaking = false;
function setVisionSpeakBtn(on) {
    visionSpeaking = on;
    if ($('vision_speak')) {
        $('vision_speak').textContent = on ? '⏹ 停止' : '🔊 朗讀';
    }
}
if ($('vision_speak')) {
    $('vision_speak').addEventListener('click', () => {
        if (visionSpeaking) { stopAllAudio(); return; }   // 念到一半按 = 停止
        if (!lastVisionText) { toast('開頭沒有可朗讀的內容'); return; }
        ensureAudioUnlocked();                              // 手機須在點擊當下解鎖音訊
        setVisionSpeakBtn(true);
        // 手動朗讀，不受自動朗讀設定影響；播放結束（自然念完或被停止）時把鈕還原
        speak(lastVisionText, byId($('vision_target').value).bcp, true, () => setVisionSpeakBtn(false));
    });
}
if ($('vision_close')) {
    $('vision_close').addEventListener('click', () => {
        stopAllAudio();                                    // 關閉同時停掉雲端與瀏覽器語音
        setVisionSpeakBtn(false);
        visionModal.classList.remove('hidden'); // 注意：新結構使用 class hidden 方式切換
        visionModal.classList.add('hidden');
        if (history.state && history.state.modal === 'vision') {
            history.back();
        }
    });
}

// 額外綁定底部關閉按鈕，讓它也點擊 vision_close
const visionCloseBtn = $('vision_close_btn');
if (visionCloseBtn) {
    visionCloseBtn.addEventListener('click', () => $('vision_close').click());
}

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

// ===== 8. 匯率 / 天氣 / 助手 =====
const CURRENCIES = [
    { code: 'TWD', label: 'TWD 台幣' },
    { code: 'USD', label: 'USD 美元' },
    { code: 'JPY', label: 'JPY 日圓' },
    { code: 'KRW', label: 'KRW 韓元' },
    { code: 'CNY', label: 'CNY 人民幣' },
    { code: 'HKD', label: 'HKD 港幣' },
    { code: 'EUR', label: 'EUR 歐元' },
    { code: 'GBP', label: 'GBP 英鎊' },
    { code: 'THB', label: 'THB 泰銖' },
    { code: 'SGD', label: 'SGD 新加坡幣' },
    { code: 'MYR', label: 'MYR 馬來幣' },
    { code: 'VND', label: 'VND 越南盾' },
    { code: 'IDR', label: 'IDR 印尼盾' },
    { code: 'PHP', label: 'PHP 披索' },
    { code: 'AUD', label: 'AUD 澳幣' },
    { code: 'CAD', label: 'CAD 加幣' },
];
function fillCur(sel, code) {
    sel.innerHTML = CURRENCIES.map(c => `<option value="${c.code}">${c.label}</option>`).join('');
    sel.value = code;
}
function fmtMoney(n) {
    if (!isFinite(n)) return '—';
    const dp = Math.abs(n) >= 100 ? 2 : 4;   // 大額 2 位、小額 4 位
    return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp });
}
function persistCur() {
    cfg.cur_from = $('cur_from').value;
    cfg.cur_to = $('cur_to').value;
    cfg.cur_amount = $('cur_amount').value;
    try { localStorage.setItem('translator_cfg', JSON.stringify(cfg)); } catch(e){}
}

let curTimer = null;
async function doConvert() {
    const amount = parseFloat($('cur_amount').value);
    const from = $('cur_from').value, to = $('cur_to').value;
    if (!isFinite(amount)) { $('cur_result').textContent = '請輸入金額'; $('cur_rate').textContent = ''; return; }
    $('cur_result').textContent = '換算中…';
    try {
        const res = await fetch('/api/currency', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ base: from, target: to, amount }),
        });
        const d = await res.json();
        if (!d.ok) throw new Error(d.error || '查詢失敗');
        $('cur_result').textContent = `${fmtMoney(amount)} ${from} = ${fmtMoney(d.result)} ${to}`;
        const when = (d.date || '').replace(' (UTC)', '').slice(0, 16);
        $('cur_rate').textContent = `1 ${from} ≈ ${fmtMoney(d.rate)} ${to}` + (when ? `　·　${when}` : '');
    } catch (e) { $('cur_result').textContent = '—'; toast(e.message); }
}
function scheduleConvert() { clearTimeout(curTimer); curTimer = setTimeout(doConvert, 350); }

if ($('s_currency')) {
    $('s_currency').addEventListener('click', () => {
        fillCur($('cur_from'), cfg.cur_from || 'USD');
        fillCur($('cur_to'), cfg.cur_to || 'TWD');
        $('cur_amount').value = cfg.cur_amount || '1';
        history.pushState({ modal: 'currency' }, '');
        $('currencyModal').classList.remove('hidden');
        doConvert();
    });
}
const closeCurrency = () => {
    $('currencyModal').classList.add('hidden');
    if (history.state && history.state.modal === 'currency') {
        history.back();
    }
};
if ($('cur_close')) $('cur_close').addEventListener('click', closeCurrency);
if ($('cur_close_x')) $('cur_close_x').addEventListener('click', closeCurrency);

if ($('cur_swap')) {
    $('cur_swap').addEventListener('click', () => {
        const a = $('cur_from').value; $('cur_from').value = $('cur_to').value; $('cur_to').value = a;
        persistCur(); doConvert();
    });
}
if ($('cur_from')) $('cur_from').addEventListener('change', () => { persistCur(); doConvert(); });
if ($('cur_to')) $('cur_to').addEventListener('change', () => { persistCur(); doConvert(); });
if ($('cur_amount')) $('cur_amount').addEventListener('input', () => { persistCur(); scheduleConvert(); });
if ($('cur_convert')) $('cur_convert').addEventListener('click', doConvert);

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
}

/* =========================================================
   天氣（Open-Meteo，免金鑰；填了 OWM 金鑰後端可改用 OpenWeatherMap）
   ========================================================= */
async function fetchWeather(payload) {
    $('wx_result').classList.add('hidden');
    $('wx_status').textContent = '查詢中…';
    try {
        const res = await fetch('/api/weather', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, owm_key: cfg.owmkey || '' }),
        });
        const d = await res.json();
        if (!d.ok) throw new Error(d.error || '查詢失敗');
        const rows = [
            `<div class="wx-place">${escapeHtml(d.place)}</div>`,
            `<div class="wx-temp">${Math.round(d.temp)}°C　${escapeHtml(d.desc)}</div>`,
            `<div class="wx-sub">體感 ${Math.round(d.feels)}°C · 濕度 ${d.humidity}%` +
                (d.hi != null ? ` · 高${Math.round(d.hi)}° 低${Math.round(d.lo)}°` : '') +
                (d.pop != null ? ` · 降雨 ${d.pop}%` : '') + `</div>`,
            `<div class="wx-advice">${escapeHtml(d.advice)}</div>`,
        ];
        $('wx_result').innerHTML = rows.join('');
        $('wx_result').classList.remove('hidden');
        $('wx_status').textContent = '';
    } catch (e) { $('wx_status').textContent = '❌ ' + e.message; }
}

if ($('s_weather')) {
    $('s_weather').addEventListener('click', () => {
        $('wx_place').value = cfg.wx_place || '';
        $('wx_result').classList.add('hidden');
        $('wx_status').textContent = '';
        history.pushState({ modal: 'weather' }, '');
        $('weatherModal').classList.remove('hidden');
        if (cfg.wx_place) fetchWeather({ place: cfg.wx_place });
    });
}
if ($('wx_go')) {
    $('wx_go').addEventListener('click', () => {
        const p = $('wx_place').value.trim();
        if (!p) { $('wx_status').textContent = '請輸入地點'; return; }
        cfg.wx_place = p;
        try { localStorage.setItem('translator_cfg', JSON.stringify(cfg)); } catch(e){}
        fetchWeather({ place: p });
    });
}
if ($('wx_place')) {
    $('wx_place').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('wx_go').click(); });
}
if ($('wx_geo')) {
    $('wx_geo').addEventListener('click', () => {
        if (!navigator.geolocation) { $('wx_status').textContent = '此裝置不支援定位'; return; }
        $('wx_status').textContent = '定位中…';
        navigator.geolocation.getCurrentPosition(
            (pos) => fetchWeather({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
            () => { $('wx_status').textContent = '無法取得位置（請允許定位權限）'; }
        );
    });
}
const closeWeather = () => {
    $('weatherModal').classList.add('hidden');
    if (history.state && history.state.modal === 'weather') {
        history.back();
    }
};
if ($('wx_close')) $('wx_close').addEventListener('click', closeWeather);
if ($('wx_close_x')) $('wx_close_x').addEventListener('click', closeWeather);

/* =========================================================
   旅遊助手問答（可選 Tavily 上網 + 設定的供應商）
   ========================================================= */
let lastAskText = '';
let askSpeaking = false;
function setAskSpeakBtn(on) { askSpeaking = on; $('ask_speak').textContent = on ? '⏹ 停止' : '🔊 朗讀'; }
async function doAsk() {
    const q = $('ask_q').value.trim();
    if (!q) { $('ask_status').textContent = '請輸入問題'; return; }
    $('ask_answer').classList.add('hidden');
    $('ask_sources').innerHTML = '';
    $('ask_status').textContent = (cfg.tavilykey ? '上網查詢並' : 'AI ') + '思考中…';
    try {
        const res = await fetch('/api/ask', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question: q,
                target: byId(cfg.s_langA || 'zh-TW').name,      // 用你的語言回答
                tavily_key: cfg.tavilykey || '',
                ...providerBody(),
            }),
        });
        const d = await res.json();
        if (!d.ok) throw new Error(d.error || '查詢失敗');
        $('ask_status').textContent = d.searched ? '🌐 已參考即時搜尋' : '';
        $('ask_answer').textContent = d.answer || '（無回覆）';
        $('ask_answer').classList.remove('hidden');
        lastAskText = d.answer || '';
        if (Array.isArray(d.sources) && d.sources.length) {
            $('ask_sources').innerHTML = '<div class="src-title">來源</div>' + d.sources.map(s =>
                `<a href="${s.url}" target="_blank" rel="noopener">${escapeHtml(s.title || s.url)}</a>`
            ).join('');
        }
        if (q && lastAskText) pushHistory('（助手）' + q, lastAskText);
    } catch (e) { $('ask_status').textContent = '❌ ' + e.message; toast(e.message); }
}
if ($('s_ask')) {
    $('s_ask').addEventListener('click', () => {
        setAskSpeakBtn(false);
        history.pushState({ modal: 'ask' }, '');
        $('askModal').classList.remove('hidden');
    });
}
if ($('ask_go')) $('ask_go').addEventListener('click', doAsk);
if ($('ask_speak')) {
    $('ask_speak').addEventListener('click', () => {
        if (askSpeaking) { stopAllAudio(); return; }
        if (!lastAskText) { toast('沒有可朗讀的內容'); return; }
        ensureAudioUnlocked();
        setAskSpeakBtn(true);
        speak(lastAskText, byId(cfg.s_langA || 'zh-TW').bcp, true, () => setAskSpeakBtn(false));
    });
}
let askRecognizer = null;
if ($('ask_mic_btn')) {
    $('ask_mic_btn').addEventListener('click', () => {
        ensureAudioUnlocked();
        if (!askRecognizer) {
            askRecognizer = new Recognizer({
                bcp: BCP[langA.value] || 'zh-TW',
                onInterim: (t) => {
                    $('ask_q').value = t;
                },
                onDone: (t) => {
                    $('ask_q').value = t.trim();
                    if (t.trim()) doAsk();
                },
                onState: (on) => {
                    const btn = $('ask_mic_btn');
                    if (btn) {
                        btn.style.background = on ? 'rgba(239, 68, 68, 0.25)' : 'rgba(59, 130, 246, 0.15)';
                        btn.style.borderColor = on ? 'rgba(239, 68, 68, 0.4)' : 'rgba(59, 130, 246, 0.3)';
                        btn.textContent = on ? '⏹ 停止' : '🎙️ 語音輸入';
                    }
                }
            });
        }
        askRecognizer.bcp = BCP[langA.value] || 'zh-TW';
        askRecognizer.toggle();
    });
}

const closeAsk = () => {
    stopAllAudio();
    setAskSpeakBtn(false);
    if (askRecognizer && askRecognizer.active) {
        askRecognizer.stop();
    }
    $('askModal').classList.add('hidden');
    if (history.state && history.state.modal === 'ask') {
        history.back();
    }
};
if ($('ask_close')) $('ask_close').addEventListener('click', closeAsk);
if ($('ask_close_x')) $('ask_close_x').addEventListener('click', closeAsk);

// --- 歷史記錄狀態管理以支援手機返回鍵關閉彈窗 ---
window.addEventListener('popstate', (e) => {
    // 當使用者按下手機返回鍵時，自動關閉所有開啟的彈窗而非離開網頁
    if (typeof visionModal !== 'undefined' && visionModal && !visionModal.classList.contains('hidden')) {
        stopAllAudio();
        setVisionSpeakBtn(false);
        visionModal.classList.add('hidden');
    }
    const settingsModal = $('settingsModal');
    if (settingsModal && settingsModal.style.display === 'flex') {
        applyTheme(cfg.theme); // 還原主題
        settingsModal.style.display = 'none';
    }
    const currencyModal = $('currencyModal');
    if (currencyModal && !currencyModal.classList.contains('hidden')) {
        currencyModal.classList.add('hidden');
    }
    const weatherModal = $('weatherModal');
    if (weatherModal && !weatherModal.classList.contains('hidden')) {
        weatherModal.classList.add('hidden');
    }
    const askModal = $('askModal');
    if (askModal && !askModal.classList.contains('hidden')) {
        stopAllAudio();
        setAskSpeakBtn(false);
        if (askRecognizer && askRecognizer.active) {
            askRecognizer.stop();
        }
        askModal.classList.add('hidden');
    }
    const stockModal = $('stockModal');
    if (stockModal && !stockModal.classList.contains('hidden')) {
        stockModal.classList.add('hidden');
    }
    const mapModal = $('mapModal');
    if (mapModal && !mapModal.classList.contains('hidden')) {
        mapModal.classList.add('hidden');
    }
    const emergencyModal = $('emergencyModal');
    if (emergencyModal && !emergencyModal.classList.contains('hidden')) {
        emergencyModal.classList.add('hidden');
    }
    const phraseModal = $('phraseModal');
    if (phraseModal && !phraseModal.classList.contains('hidden')) {
        stopAllAudio();
        phraseModal.classList.add('hidden');
    }
});


/* =========================================================
   股價查詢 與 今日行情
   ========================================================= */
async function loadMarketStats() {
    const listEl = $('market_list');
    if (!listEl) return;
    listEl.innerHTML = '<div style="text-align: center; color: var(--text-secondary); font-size: 0.85rem; padding: 15px 0;">📊 行情刷新中…</div>';
    
    try {
        const res = await fetch('/api/stock/market');
        const d = await res.json();
        if (!d.ok) throw new Error(d.error || '載入失敗');
        
        listEl.innerHTML = d.data.map(item => {
            const isUp = item.change >= 0;
            const sign = isUp ? '▲' : '▼';
            const color = isUp ? '#2dd4bf' : '#ff4d4d'; // 美麗的亮綠/紅色
            
            return `
                <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); padding: 8px 12px; border-radius: 8px;">
                    <div>
                        <div style="font-size: 0.85rem; font-weight: bold; color: var(--text-primary);">${item.name}</div>
                        <div style="font-size: 0.7rem; color: var(--text-secondary);">${item.symbol}</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 0.9rem; font-weight: bold; color: var(--text-primary);">${item.price} <span style="font-size: 0.7rem; color: var(--text-secondary); font-weight: normal;">${item.currency}</span></div>
                        <div style="font-size: 0.75rem; font-weight: bold; color: ${color};">${sign} ${Math.abs(item.change)} (${item.percent}%)</div>
                    </div>
                </div>
            `;
        }).join('');
    } catch(e) {
        listEl.innerHTML = `<div style="text-align: center; color: #ff4d4d; font-size: 0.85rem; padding: 15px 0;">❌ 行情載入失敗 (${e.message})</div>`;
    }
}

async function doStockQuery() {
    const symbol = $('stock_symbol').value.trim();
    if (!symbol) { $('stock_status').textContent = '請輸入股價代號'; return; }
    $('stock_result').classList.add('hidden');
    $('stock_status').textContent = '查詢中…';
    try {
        const res = await fetch('/api/stock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol }),
        });
        const d = await res.json();
        if (!d.ok) throw new Error(d.error || '查詢失敗');
        $('stock_title').textContent = `${d.symbol} 市場常規價格`;
        $('stock_price').textContent = `${d.price} ${d.currency}`;
        const isUp = d.change >= 0;
        $('stock_change').innerHTML = `<span style="color: ${isUp ? '#2dd4bf' : '#ff4d4d'}; font-weight: bold;">${isUp ? '▲' : '▼'} ${Math.abs(d.change)} (${d.percent}%)</span>`;
        $('stock_result').classList.remove('hidden');
        $('stock_status').textContent = '';
    } catch (e) { $('stock_status').textContent = '❌ ' + e.message; }
}

if ($('s_stock')) {
    $('s_stock').addEventListener('click', () => {
        $('stock_symbol').value = '';
        $('stock_result').classList.add('hidden');
        $('stock_status').textContent = '';
        history.pushState({ modal: 'stock' }, '');
        $('stockModal').classList.remove('hidden');
        loadMarketStats(); // 彈窗打開時自動加載今日大盤行情！
    });
}
if ($('stock_go')) $('stock_go').addEventListener('click', doStockQuery);
if ($('stock_symbol')) {
    $('stock_symbol').addEventListener('keydown', (e) => { if (e.key === 'Enter') doStockQuery(); });
}
const closeStock = () => {
    $('stockModal').classList.add('hidden');
    if (history.state && history.state.modal === 'stock') {
        history.back();
    }
};
if ($('stock_close')) $('stock_close').addEventListener('click', closeStock);
if ($('stock_close_x')) $('stock_close_x').addEventListener('click', closeStock);


/* =========================================================
   地圖導航
   ========================================================= */
async function doMapQuery() {
    const place = $('map_place').value.trim();
    if (!place) { $('map_status').textContent = '請輸入目的地'; return; }
    $('map_result').classList.add('hidden');
    $('map_status').textContent = '景點分析中…';
    try {
        // 呼叫旅遊問答的後端 API 來幫我們做景點簡介
        const res = await fetch('/api/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question: `介紹景點 ${place} 及其交通路線，以繁體中文回答，不超過 60 字。`,
                target: 'Traditional Chinese',
                tavily_key: cfg.tavilykey || '',
                ...providerBody(),
            }),
        });
        const d = await res.json();
        if (!d.ok) throw new Error(d.error || '分析失敗');
        $('map_summary').textContent = d.answer || '景點簡介載入中...';
        
        // 設定 Google Maps 連結
        $('map_link').onclick = () => {
            window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`, '_blank');
        };
        
        $('map_result').classList.remove('hidden');
        $('map_status').textContent = '';
    } catch (e) { 
        // 失敗時僅提供導航按鈕
        $('map_summary').textContent = '導航連結已備妥，請直接開啟：';
        $('map_link').onclick = () => {
            window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`, '_blank');
        };
        $('map_result').classList.remove('hidden');
        $('map_status').textContent = '';
    }
}

if ($('s_map')) {
    $('s_map').addEventListener('click', () => {
        $('map_place').value = '';
        $('map_result').classList.add('hidden');
        $('map_status').textContent = '';
        history.pushState({ modal: 'map' }, '');
        $('mapModal').classList.remove('hidden');
    });
}
if ($('map_go')) $('map_go').addEventListener('click', doMapQuery);
if ($('map_place')) {
    $('map_place').addEventListener('keydown', (e) => { if (e.key === 'Enter') doMapQuery(); });
}
const closeMap = () => {
    $('mapModal').classList.add('hidden');
    if (history.state && history.state.modal === 'map') {
        history.back();
    }
};
if ($('map_close')) $('map_close').addEventListener('click', closeMap);
if ($('map_close_x')) $('map_close_x').addEventListener('click', closeMap);


/* =========================================================
   緊急聯絡
   ========================================================= */
const EMERGENCY_NUMBERS = {
    'zh-TW': { country: '台灣 (Taiwan)', police: '110', ambulance: '119', fire: '119' },
    'en': { country: '美國 (United States)', police: '911', ambulance: '911', fire: '911' },
    'ja': { country: '日本 (Japan)', police: '110', ambulance: '119', fire: '119' },
    'ko': { country: '韓國 (South Korea)', police: '112', ambulance: '119', fire: '119' },
    'vi': { country: '越南 (Vietnam)', police: '113', ambulance: '115', fire: '114' },
    'de': { country: '德國 (Germany)', police: '112', ambulance: '112', fire: '112' },
};

function renderEmergencyNumbers() {
    const listEl = $('emergency_list');
    if (!listEl) return;
    
    const tgtLang = (langB && langB.value) || cfg.s_langB || 'en';
    const info = EMERGENCY_NUMBERS[tgtLang] || EMERGENCY_NUMBERS['en'];
    
    listEl.innerHTML = `
        <div style="font-size: 1rem; font-weight: bold; color: #ff4d4d; margin-bottom: 8px; text-align: center;">📍 當前國家/地區：${info.country}</div>
        <a href="tel:${info.police}" style="text-decoration: none;">
            <button class="save-btn" style="margin-top: 0; background: #ef4444; color: white; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 1.05rem; border: none;">📞 報警撥打：${info.police}</button>
        </a>
        <a href="tel:${info.ambulance}" style="text-decoration: none;">
            <button class="save-btn" style="margin-top: 0; background: #ea580c; color: white; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 1.05rem; border: none;">🚑 救護車撥打：${info.ambulance}</button>
        </a>
        ${info.ambulance !== info.fire ? `
        <a href="tel:${info.fire}" style="text-decoration: none;">
            <button class="save-btn" style="margin-top: 0; background: #dc2626; color: white; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 1.05rem; border: none;">🔥 消防局撥打：${info.fire}</button>
        </a>` : ''}
    `;
}

if ($('s_emergency')) {
    $('s_emergency').addEventListener('click', () => {
        renderEmergencyNumbers();
        history.pushState({ modal: 'emergency' }, '');
        $('emergencyModal').classList.remove('hidden');
    });
}
const closeEmergency = () => {
    $('emergencyModal').classList.add('hidden');
    if (history.state && history.state.modal === 'emergency') {
        history.back();
    }
};
if ($('emergency_close')) $('emergency_close').addEventListener('click', closeEmergency);
if ($('emergency_close_x')) $('emergency_close_x').addEventListener('click', closeEmergency);


/* =========================================================
   實用句庫
   ========================================================= */
const PHRASE_TEMPLATES = {
    greetings: ["你好", "謝謝", "不好意思 / 麻煩一下", "請幫我拍照", "請問..."],
    dining: ["請給我菜單", "我想點這個", "請結帳 (買單)", "有熱水嗎", "我不吃香菜"],
    transit: ["請問車票多少錢", "這班車去哪裡", "捷運站在哪裡", "離這裡遠嗎", "我想去這個地址"],
    emergency: ["請幫幫我", "我迷路了", "我的錢包不見了", "有會說中文的人嗎", "需要看醫生"]
};

let translatedPhrasesCache = {};

async function renderPhrases() {
    const cat = $('phrase_category').value;
    const listEl = $('phrase_list');
    if (!listEl) return;
    
    const phrases = PHRASE_TEMPLATES[cat] || [];
    const srcName = NAME[langA.value] || 'Traditional Chinese';
    const tgtId = langB.value;
    const tgtName = NAME[tgtId] || 'English';
    const tgtBcp = BCP[tgtId] || 'en-US';
    
    listEl.innerHTML = phrases.map((ph, idx) => {
        const cacheKey = `${tgtId}_${cat}_${idx}`;
        const trans = translatedPhrasesCache[cacheKey] || '翻譯載入中…';
        return `
            <button class="save-btn phrase-item-btn" data-text="${escapeHtml(trans)}" data-bcp="${tgtBcp}" data-key="${cacheKey}" data-source="${escapeHtml(ph)}" style="margin-top: 0; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255,255,255,0.06); color: white; display: flex; flex-direction: column; align-items: flex-start; padding: 10px 14px; text-align: left; border-radius: 10px; gap: 4px; width: 100%; cursor: pointer;">
                <span style="font-size: 0.78rem; color: var(--text-secondary);">${ph}</span>
                <span class="phrase-trans-text" style="font-size: 0.95rem; font-weight: 700; color: #c084fc;">${trans}</span>
            </button>
        `;
    }).join('');
    
    // Async translate each phrase
    phrases.forEach(async (ph, idx) => {
        const cacheKey = `${tgtId}_${cat}_${idx}`;
        if (translatedPhrasesCache[cacheKey]) return; // Already cached
        
        try {
            const transText = await translate(ph, srcName, tgtName);
            translatedPhrasesCache[cacheKey] = transText;
            
            // Find the button and update it
            const btn = listEl.querySelector(`[data-key="${cacheKey}"]`);
            if (btn) {
                btn.setAttribute('data-text', transText);
                const span = btn.querySelector('.phrase-trans-text');
                if (span) span.textContent = transText;
            }
        } catch(e) {
            const btn = listEl.querySelector(`[data-key="${cacheKey}"]`);
            if (btn) {
                const span = btn.querySelector('.phrase-trans-text');
                if (span) span.textContent = '(翻譯失敗)';
            }
        }
    });
}

if ($('s_phrases')) {
    $('s_phrases').addEventListener('click', () => {
        history.pushState({ modal: 'phrase' }, '');
        $('phraseModal').classList.remove('hidden');
        renderPhrases();
    });
}
if ($('phrase_category')) {
    $('phrase_category').addEventListener('change', renderPhrases);
}
if ($('phrase_list')) {
    $('phrase_list').addEventListener('click', (e) => {
        const btn = e.target.closest('.phrase-item-btn');
        if (!btn) return;
        const text = btn.getAttribute('data-text');
        const bcp = btn.getAttribute('data-bcp');
        if (text && text !== '翻譯載入中…' && text !== '(翻譯失敗)') {
            ensureAudioUnlocked();
            speak(text, bcp);
        }
    });
}
const closePhrase = () => {
    stopAllAudio();
    $('phraseModal').classList.add('hidden');
    if (history.state && history.state.modal === 'phrase') {
        history.back();
    }
};
if ($('phrase_close')) $('phrase_close').addEventListener('click', closePhrase);
if ($('phrase_close_x')) $('phrase_close_x').addEventListener('click', closePhrase);


