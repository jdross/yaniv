(function () {
  function fallbackUuidV4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  window.getYanivPid = function getYanivPid() {
    let id = localStorage.getItem('yaniv_pid');
    if (!id) {
      id = (typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : fallbackUuidV4();
      localStorage.setItem('yaniv_pid', id);
    }
    return id;
  };
})();
