(() => {
  const settings = document.currentScript?.dataset;
  if (!settings?.pixel || navigator.globalPrivacyControl === true || navigator.doNotTrack === '1') return;
  const start = () => {
    // Queue the event while the optional SDK loads. A blocked SDK cannot block
    // rendering, sign-in, or the next action on the welcome page.
    const twq = window.twq || function () {
      if (twq.exe) twq.exe.apply(twq, arguments);
      else twq.queue.push(arguments);
    };
    if (!window.twq) {
      twq.version = '1.1';
      twq.queue = [];
      window.twq = twq;
      const script = document.createElement('script');
      script.async = true;
      script.src = 'https://static.ads-twitter.com/uwt.js';
      document.head.appendChild(script);
    }
    twq('config', settings.pixel);
    if (settings.event && settings.conversionId) {
      twq('event', settings.event, { conversion_id: settings.conversionId, status: 'completed' });
    }
  };
  // Access waits for window.load to reveal its fonts and layout. Load the ad SDK
  // afterwards so an unavailable tracking service never delays that reveal.
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
})();
