const fs = require('fs');

const code = fs.readFileSync('vendor/ffmpeg/ffmpeg.js', 'utf8');

Object.assign(global, {self: global, window: global, document: {baseURI: 'http://localhost/'}});
eval(code);

console.log('Keys in global:', Object.keys(global).filter(k => k.toLowerCase().includes('ffmpeg')));
console.log('typeof FFmpegWASM:', typeof FFmpegWASM);
if (typeof FFmpegWASM !== 'undefined') {
    console.log('FFmpegWASM keys:', Object.keys(FFmpegWASM));
}
