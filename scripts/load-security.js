hexo.extend.filter.register('after_render:html', function(str, data) {
    const securityScript = `
    <script src="/js/security.js"></script>
    `;
    return str.replace('</head>', securityScript + '</head>');
});
