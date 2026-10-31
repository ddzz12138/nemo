import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineParts, messageBlocks } from '../desktop/interface/src/message-format.mjs';

test('assistant replies format paragraphs, emphasis and lists instead of exposing Markdown markers', () => {
  assert.deepEqual(messageBlocks('Hello.\n\n## Saturday\n\n- Walk together\n- Lunch\n\n1. Start\n2. Finish'), [
    {type:'paragraph',text:'Hello.'}, {type:'heading',text:'Saturday'},
    {type:'list',ordered:false,items:['Walk together','Lunch']},
    {type:'list',ordered:true,start:1,items:['Start','Finish']},
  ]);
  assert.deepEqual(inlineParts('A **bold** word and `code`.'), [
    {type:'text',text:'A '},{type:'strong',text:'bold'},{type:'text',text:' word and '},{type:'code',text:'code'},{type:'text',text:'.'},
  ]);
});
test('raw model HTML and executable link text stay text tokens, including inside formatting', () => {
  const input='<img src=x onerror=alert(1)>\n\n**<script>alert(1)</script>**\n\n[click](javascript:alert(1))';
  const blocks=messageBlocks(input);
  assert.deepEqual(blocks.map(block=>block.type),['paragraph','paragraph','paragraph']);
  assert.equal(inlineParts(blocks[1].text)[0].text,'<script>alert(1)</script>');
  assert.equal(inlineParts(blocks[2].text)[0].type,'text');
  assert.ok(blocks.every(block=>!Object.hasOwn(block,'html')&&!Object.hasOwn(block,'href')));
});
test('streamed unfinished code fences remain readable and preserve literal source', () => {
  const source='Before\n\n```html\n<script>literal()</script>\nline two';
  assert.deepEqual(messageBlocks(source),[{type:'paragraph',text:'Before'},{type:'code',text:'<script>literal()</script>\nline two'}]);
  assert.deepEqual(messageBlocks(source+'\n```\n\nAfter'),[{type:'paragraph',text:'Before'},{type:'code',text:'<script>literal()</script>\nline two'},{type:'paragraph',text:'After'}]);
});
test('large blocks use bounded plain text and quotes retain line boundaries', () => {
  const large='*'.repeat(70_000);assert.deepEqual(inlineParts(large),[{type:'text',text:large}]);
  assert.deepEqual(messageBlocks('> First\r\n> Second\r\n\r\nDone'),[{type:'quote',text:'First\nSecond'},{type:'paragraph',text:'Done'}]);
});
test('numbered replies retain their starting number and excessively long markers stay plain text', () => {
  assert.deepEqual(messageBlocks('3. Third step\n4. Fourth step'),[{type:'list',ordered:true,start:3,items:['Third step','Fourth step']}]);
  assert.equal(messageBlocks('1234567890. Literal long marker')[0].type,'paragraph');
});
