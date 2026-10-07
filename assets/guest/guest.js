(() => {
  const meeting = document.getElementById('segLunch');
  const overnight = document.getElementById('segNight');
  function setMode(night) {
    document.body.classList.toggle('mode-overnight', night);
    document.body.classList.toggle('mode-meeting', !night);
    meeting.classList.toggle('active', !night);
    overnight.classList.toggle('active', night);
    meeting.setAttribute('aria-pressed', String(!night));
    overnight.setAttribute('aria-pressed', String(night));
  }
  meeting.addEventListener('click', () => setMode(false));
  overnight.addEventListener('click', () => setMode(true));
})();
