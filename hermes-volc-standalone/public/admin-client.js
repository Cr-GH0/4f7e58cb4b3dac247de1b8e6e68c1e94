import { ADMIN_MARKUP, mountAdmin } from './admin-view.js';
const host = document.querySelector('#app');
host.innerHTML = ADMIN_MARKUP;
mountAdmin(host);
