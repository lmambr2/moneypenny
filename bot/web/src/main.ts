import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router/index.js';
import { installApiClient } from './api/http.js';
import './styles/global.scss';
import './styles/mobile.scss';

installApiClient();

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
