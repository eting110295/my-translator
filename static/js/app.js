/* ============================================
   JavaScript 骨架：基本初始化 + API 健康檢查
   ============================================ */

console.log('app.js 已載入');

/* ============================================
   全局變量
   ============================================ */
let langA, langB, result;

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
    
    recognition.onend = () => {
        console.log('🎤 聽寫結束');
        if (micBtn) {
            micBtn.classList.remove('recording');
            micBtn.style.opacity = '1';
            const micLabel = micBtn.querySelector('.mic-label');
            if (micLabel) {
                micLabel.textContent = '點一下開始說話';
            }
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
    document.getElementById('send').onclick = async () => {
        const text = document.getElementById('inputText').value.trim();
        if (!text) return;
        
        result.textContent = '翻譯中…';
        try {
            const out = await translate(text, NAME[langA.value], NAME[langB.value]);
            result.textContent = out;
        } catch (e) {
            result.textContent = '（翻譯失敗）';
            alert(e.message);
        }
    };
    
    // 麥克風按鈕 - 語音輸入
    const micBtn = document.getElementById('micBtn');
    if (micBtn && SpeechRecognition) {
        // 初始化語音識別
        setupSpeechRecognition();
        
        // 點擊麥克風按鈕開始聽寫
        micBtn.addEventListener('click', () => {
            startListening();
        });
    } else if (micBtn && !SpeechRecognition) {
        micBtn.style.opacity = '0.5';
        micBtn.title = '您的瀏覽器不支持語音識別';
    }
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
