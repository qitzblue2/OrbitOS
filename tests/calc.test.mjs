import {evaluate} from '../packages/orbit-launcher/orbit-launcher@orbit-os/calc.js';
const c=[['2+2',4],['2*(3+4)',14],['2^3^2',512],['-3+5',2],['10/4',2.5],['1,5*2',3],['hello',null],['42',null],['2+',null],['1/0',null]];
let bad=0;for(const [q,e] of c){const v=evaluate(q);if(v!==e){bad++;console.log('FAIL',q,v,e)}}
console.log(bad?'calc tests failed':'calc tests passed');process.exit(bad?1:0);
