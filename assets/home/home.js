const payTrigger = document.querySelector('.qr-trigger');
const payDialog = document.getElementById('pay-dialog');

// Pay is always a normal link. QR is an optional enhancement.
if (payTrigger && payDialog && typeof payDialog.showModal === 'function') {
  payTrigger.hidden = false;
  payTrigger.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    payDialog.showModal();
  });
  payDialog.querySelector('.pay-close').addEventListener('click', () => payDialog.close());
  payDialog.addEventListener('click', (event) => {
    const bounds = payDialog.getBoundingClientRect();
    if (event.target === payDialog &&
        (event.clientX < bounds.left || event.clientX > bounds.right ||
         event.clientY < bounds.top || event.clientY > bounds.bottom)) {
      payDialog.close();
    }
  });
}
