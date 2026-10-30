try {
  var storedTheme = JSON.parse(localStorage.getItem('infinite-canvas:theme_store') || '{}');
  var initialTheme = storedTheme.state && storedTheme.state.theme === 'light' ? 'light' : 'dark';
  document.documentElement.classList.toggle('dark', initialTheme === 'dark');
  document.documentElement.style.colorScheme = initialTheme;
} catch {
  // Invalid local preferences fall back to the dark class already on <html>.
}
