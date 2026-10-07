(() => {
  const form = document.getElementById('formBody');
  const button = document.getElementById('submitBtn');
  const error = document.getElementById('formError');
  const fields = ['email', 'fullName', 'phone', 'arrivalDate', 'arrivalTime', 'departureDate', 'departureTime', 'food', 'ec1Name', 'ec1Phone', 'ec2Name', 'ec2Phone'];
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    error.classList.remove('show');
    if (!form.reportValidity()) return;
    const data = new URLSearchParams();
    for (const name of fields) {
      const field = document.getElementById(name);
      if (!field.value.trim()) {
        error.textContent = 'Please fill in every field so we can take good care of you.';
        error.classList.add('show');
        field.focus();
        return;
      }
      data.append(name, field.value.trim());
    }
    button.disabled = true;
    button.textContent = 'Sending your registration…';
    try {
      // The existing Apps Script endpoint accepts form-encoded, no-CORS requests.
      // An opaque response confirms the request was sent, not server processing.
      await fetch(ENDPOINT, {method:'POST', mode:'no-cors', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:data.toString()});
      form.hidden = true;
      document.querySelector('.form-intro').hidden = true;
      const success = document.getElementById('formSuccess');
      success.hidden = false;
      success.focus({preventScroll:true});
      success.scrollIntoView({behavior:'smooth', block:'center'});
    } catch (_) {
      error.textContent = 'Your registration could not be sent. Please check your connection and try again.';
      error.classList.add('show');
      error.focus();
      button.disabled = false;
      button.textContent = 'Try sending again ↗';
    }
  });
})();
