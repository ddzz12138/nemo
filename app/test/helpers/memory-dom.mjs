// Lightweight DOM for behavioral tests. Native selection, dialogs and layout
// are verified independently in the real browser fixture.
export class Element {
 constructor(doc,tag){Object.assign(this,{ownerDocument:doc,tagName:tag.toUpperCase(),children:[],parentElement:null,attributes:new Map(),listeners:new Map(),hidden:false,disabled:false,open:false,value:'',checked:false,_text:''});}
 set textContent(value){for(const node of this.children)node.parentElement=null;this.children=[];this._text=String(value);}
 get textContent(){return this._text+this.children.map(node=>node.textContent).join(' ');}
 setAttribute(key,value){this.attributes.set(key,String(value));}getAttribute(key){return this.attributes.get(key)??null;}removeAttribute(key){this.attributes.delete(key);}
 append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
 addEventListener(type,listener){this.listeners.set(type,listener);}
 fire(type,extra={}){const event={currentTarget:this,target:this,key:extra.key||'',preventDefault(){this.defaultPrevented=true;}};this.listeners.get(type)?.(event);return event;}
 click(){if(this.disabled)return;const event=this.fire('click');if(this.type==='submit'&&!event.defaultPrevented){let form=this.parentElement;while(form&&form.tagName!=='FORM')form=form.parentElement;form?.fire('submit');}}
 focus(){this.ownerDocument.activeElement=this;}showModal(){this.open=true;}close(){this.open=false;}
}
export function all(root){return[root,...root.children.flatMap(all)];}
export function memoryDom(){const doc={createElement:tag=>new Element(doc,tag),getElementById:id=>all(doc.body).find(node=>node.getAttribute('id')===id)||null};doc.body=doc.createElement('body');doc.activeElement=doc.body;return{doc,id:id=>doc.getElementById(id),button:name=>{const node=all(doc.body).find(node=>node.tagName==='BUTTON'&&(node.getAttribute('aria-label')||node.textContent)===name);if(!node)throw Error('Missing button '+name);return node;}};}
