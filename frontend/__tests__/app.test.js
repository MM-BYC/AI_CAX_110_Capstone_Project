/**
 * @jest-environment jsdom
 */

// Load the DOM from index.html to ensure elements exist
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

document.documentElement.innerHTML = html;

// Ensure setup.js runs (Jest config already points to it), then require the app script
require('../app.js');

describe('frontend app behaviors', () => {
  beforeEach(() => {
    // Clear DOM changes between tests
    jest.clearAllMocks();
    // Reset UI elements to initial states
    const outputBox = document.getElementById('outputText');
    const copyBtn = document.getElementById('copyBtn');
    outputBox.innerHTML = '<span class="placeholder">Translation will appear here...</span>';
    copyBtn.style.display = 'none';

    const audioOutputBox = document.getElementById('audioOutputText');
    const audioCopyBtn = document.getElementById('audioCopyBtn');
    audioOutputBox.innerHTML = '<span class="placeholder">Translation will appear here...</span>';
    audioCopyBtn.style.display = 'none';

    // Reset char count
    const charCount = document.getElementById('charCount');
    charCount.textContent = '';

    // Reset source language selects
    const textSourceLang = document.getElementById('textSourceLang');
    if (textSourceLang) {
      textSourceLang.value = 'auto';
      const opt = textSourceLang.querySelector('option[value="auto"]');
      if (opt) opt.textContent = 'Detect Language';
    }
  });

  test('Should show placeholder and hide copy button when output is empty', () => {
    const { setOutput } = window;
    const outputBox = document.getElementById('outputText');
    const copyBtn = document.getElementById('copyBtn');

    // Call setOutput with empty string
    setOutput("");

    expect(outputBox.innerHTML).toContain('Translation will appear here...');
    expect(copyBtn.style.display).toBe('none');
  });

  test('Should display translation and show copy button when setOutput is given text', () => {
    const { setOutput } = window;
    const outputBox = document.getElementById('outputText');
    const copyBtn = document.getElementById('copyBtn');

    setOutput('Hello world');

    expect(outputBox.textContent).toBe('Hello world');
    expect(copyBtn.style.display).toBe('inline-block');
  });

  test('Should update character count correctly for single vs multiple characters', () => {
    const { updateCharCount } = window;
    const charCount = document.getElementById('charCount');

    updateCharCount(1);
    expect(charCount.textContent).toBe('1 character');

    updateCharCount(5);
    expect(charCount.textContent).toBe('5 characters');
  });

  test('Should detect language and update the auto option label when detect API returns a language', async () => {
    // Mock fetch for detect_language
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ detected_language: 'es' })
    });

    const inputText = document.getElementById('inputText');
    const textSourceLang = document.getElementById('textSourceLang');

    inputText.value = 'Hola';
    // Call detectAndShowLanguage from the window
    await window.detectAndShowLanguage('Hola');

    const opt = textSourceLang.querySelector('option[value="auto"]');
    expect(opt.textContent).toContain('Detected');
    expect(opt.textContent).toContain('Spanish');
  });

  test('Should handle non-OK translate_text response by showing an error', async () => {
    // Mock fetch for translate_text to return non-ok
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ detail: 'Server exploded' })
    });

    const inputText = document.getElementById('inputText');
    const textSourceLang = document.getElementById('textSourceLang');
    const textTargetLang = document.getElementById('textTargetLang');

    inputText.value = 'Test';
    textSourceLang.value = 'en';
    textTargetLang.value = 'es';

    // Call liveTranslate (exposed on window)
    await window.liveTranslate();

    const outputBox = document.getElementById('outputText');
    expect(outputBox.textContent).toMatch(/Error:/);
  });
});
