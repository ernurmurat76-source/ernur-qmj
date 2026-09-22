'use strict';

const $ = selector => document.querySelector(selector);

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('#toast').classList.add('hidden'), 2500);
}

function formatExpiry(value) {
  return new Intl.DateTimeFormat('kk-KZ', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(value));
}

document.querySelectorAll('[data-days]').forEach(button => {
  button.addEventListener('click', () => {
    $('#durationDays').value = button.dataset.days;
  });
});

$('#adminForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#createCodeButton');
  const days = Number($('#durationDays').value);
  $('#adminError').textContent = '';
  $('#createdCode').classList.add('hidden');
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    $('#adminError').textContent = '1 мен 365 аралығындағы толық күн санын енгізіңіз';
    return;
  }
  button.disabled = true;
  button.textContent = 'Код жасалып жатыр...';
  try {
    const response = await fetch('/api/admin/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#adminPassword').value, days })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Код жасалмады');
    $('#codeValue').textContent = data.code;
    $('#codeExpiry').textContent = `${data.days} күнге берілді. ${formatExpiry(data.expiresAt)} дейін жарамды.`;
    $('#createdCode').classList.remove('hidden');
    toast('Жаңа код дайын');
  } catch (error) {
    $('#adminError').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Жаңа код жасау';
  }
});

$('#copyCodeButton').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#codeValue').textContent);
  toast('Код көшірілді');
});
