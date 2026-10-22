(() => {
  const form = document.getElementById('formBody');
  const button = document.getElementById('submitBtn');
  const error = document.getElementById('formError');
  const fields = ['email', 'fullName', 'phone', 'arrivalDate', 'arrivalTime', 'departureDate', 'departureTime', 'dietaryRestrictions', 'foodPreferences', 'ec1Name', 'ec1Relation', 'ec1Phone', 'ec2Name', 'ec2Relation', 'ec2Phone'];
  const preferences = document.getElementById('foodPreferences');
  preferences.addEventListener('input', () => preferences.setCustomValidity(''));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    error.classList.remove('show');
    const genericPreference = /^(none|n\/?a|no preferences?|anything|whatever|nothing|not applicable)[.!]*$/i;
    preferences.setCustomValidity(genericPreference.test(preferences.value.trim())
      ? 'Please share a few foods or meals you enjoy, even if you have no dietary restrictions.'
      : '');
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
    // Label both answers in the existing food field so the sheet and host
    // notification retain both without changing the deployed endpoint.
    data.set('food', `Dietary restrictions & food allergies: ${data.get('dietaryRestrictions')}\n\nFood preferences (favorites & dislikes): ${data.get('foodPreferences')}`);
    data.delete('dietaryRestrictions');
    data.delete('foodPreferences');
    // Preserve the existing sheet and email contract: each contact name includes
    // their relationship, collected and validated separately in the form.
    for (const contact of ['ec1', 'ec2']) {
      data.set(`${contact}Name`, `${data.get(`${contact}Name`)} (${data.get(`${contact}Relation`)})`);
      data.delete(`${contact}Relation`);
    }
    button.disabled = true;
    button.textContent = 'Sending your registration…';
    try {
      // The existing Apps Script endpoint accepts form-encoded, no-CORS requests.
      // An opaque response confirms the request was sent, not server processing.
      await fetch(ENDPOINT, {method:'POST', mode:'no-cors', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:data.toString()});
      window.MikeKAnalytics?.track({id:'guest-registration-sent',kind:'action',label:'Guest registration request sent'});
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
