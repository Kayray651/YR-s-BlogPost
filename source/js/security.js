(function() {
    'use strict';

    // 1. 检测 iframe 劫持
    if (window.top !== window.self) {
        console.warn('[Security] 检测到 iframe 劫持，尝试跳转到原始页面...');
        try {
            window.top.location = window.self.location;
        } catch (e) {
            console.error('[Security] 跳转失败:', e);
            alert('检测到页面被劫持！');
        }
    }

    // 2. 检测和移除恶意脚本注入
    function detectMaliciousInjection() {
        const forbiddenKeywords = ['ad', 'advertisement', 'pop', 'popup', 'hijack', 'inject'];
        const scripts = document.querySelectorAll('script[src], script:not([src])');
        
        scripts.forEach(function(script) {
            if (script.src && forbiddenKeywords.some(keyword => script.src.toLowerCase().includes(keyword))) {
                console.warn('[Security] 检测到可疑脚本:', script.src);
                script.remove();
            }
        });
    }

    // 3. 检测和移除恶意广告
    function removeMaliciousAds() {
        const adSelectors = [
            'iframe[src*="ad"]',
            'iframe[src*="advertisement"]',
            'div[class*="ad"]',
            'div[id*="ad"]',
            'ins',
            'script[src*="doubleclick"]',
            'script[src*="googlesyndication"]'
        ];
        
        adSelectors.forEach(function(selector) {
            document.querySelectorAll(selector).forEach(function(el) {
                console.warn('[Security] 移除广告元素:', el);
                el.remove();
            });
        });
    }

    // 4. 检测 URL 篡改
    function detectUrlTampering() {
        const originalUrl = window.location.href;
        setInterval(function() {
            if (window.location.href !== originalUrl) {
                console.warn('[Security] 检测到 URL 被篡改！');
            }
        }, 1000);
    }

    // 5. 阻止右键菜单被禁用
    document.addEventListener('contextmenu', function(e) {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
            return;
        }
    }, true);

    // 6. 检测 DOM 篡改
    const originalWrite = document.write;
    document.write = function() {
        console.warn('[Security] 检测到 document.write 调用');
        return originalWrite.apply(document, arguments);
    };

    // 初始化安全检查
    document.addEventListener('DOMContentLoaded', function() {
        console.log('[Security] 安全脚本已加载');
        detectMaliciousInjection();
        removeMaliciousAds();
        detectUrlTampering();
    });

    // 定期检查
    setInterval(function() {
        detectMaliciousInjection();
        removeMaliciousAds();
    }, 3000);
})();
