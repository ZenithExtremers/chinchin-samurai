/* Firebase の設定（オンライン対戦用）
   作り方は README の「オンライン対戦の準備」を見てください。
   Firebase コンソールの「プロジェクトの設定 → マイアプリ」にある firebaseConfig の中身をここに貼ります。
   databaseURL（Realtime Database の URL）も必ず入れてください。
   この値は公開しても大丈夫なもの（データの守りは database.rules.json で行います）。
   null のままだとオンライン対戦はオフになり、1台で遊ぶ機能はそのまま使えます。 */
window.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAGx8ONya4o1xEmoYJit6FavwPQwS4KyI8',
  authDomain: 'chinchin-samurai.firebaseapp.com',
  databaseURL: 'https://chinchin-samurai-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'chinchin-samurai',
  storageBucket: 'chinchin-samurai.firebasestorage.app',
  messagingSenderId: '1086001222920',
  appId: '1:1086001222920:web:2814a81cb7ba523a9848bd',
};
/* 例：
window.FIREBASE_CONFIG = {
  apiKey: 'AIza...',
  authDomain: 'chinchin-samurai-xxxx.firebaseapp.com',
  databaseURL: 'https://chinchin-samurai-xxxx-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'chinchin-samurai-xxxx',
  storageBucket: 'chinchin-samurai-xxxx.firebasestorage.app',
  messagingSenderId: '1234567890',
  appId: '1:1234567890:web:abcdef',
};
*/
