'use strict';
function removeEmulationPrevention(bytes){const out=[];for(let i=0;i<bytes.length;i++){if(i>=2&&bytes[i]===0x03&&bytes[i-1]===0x00&&bytes[i-2]===0x00)continue;out.push(bytes[i]);}return Buffer.from(out);}
class BitReader{constructor(buffer){this.buffer=buffer;this.bit=0;}readBit(){const byte=this.buffer[this.bit>>3]||0;const value=(byte>>(7-(this.bit&7)))&1;this.bit++;return value;}readBits(count){let value=0;for(let i=0;i<count;i++)value=(value<<1)|this.readBit();return value>>>0;}readUE(){let zeros=0;while(this.readBit()===0&&zeros<32)zeros++;return (1<<zeros)-1+this.readBits(zeros);}readSE(){const value=this.readUE();return value&1?(value+1)>>1:-(value>>1);}}
function parseSpsDimensions(sps){
  try{
    const rbsp=removeEmulationPrevention(sps.subarray(1)),bits=new BitReader(rbsp),profileIdc=bits.readBits(8);bits.readBits(16);bits.readUE();
    let chromaFormatIdc=1;
    if([100,110,122,244,44,83,86,118,128,138,139,134,135].includes(profileIdc)){chromaFormatIdc=bits.readUE();if(chromaFormatIdc===3)bits.readBit();bits.readUE();bits.readUE();if(bits.readBit()){const count=chromaFormatIdc!==3?8:12;for(let i=0;i<count;i++){if(!bits.readBit())continue;let last=8,next=8;const size=i<6?16:64;for(let j=0;j<size;j++){if(next!==0)next=(last+bits.readSE()+256)%256;last=next===0?last:next;}}}}
    bits.readUE();const pocType=bits.readUE();
    if(pocType===0)bits.readUE();else if(pocType===1){bits.readBit();bits.readSE();bits.readSE();const count=bits.readUE();for(let i=0;i<count;i++)bits.readSE();}
    bits.readUE();bits.readBit();const widthMbs=bits.readUE()+1,heightUnits=bits.readUE()+1,frameMbsOnly=bits.readBit();if(!frameMbsOnly)bits.readBit();bits.readBit();
    let crop=[0,0,0,0];
    if(bits.readBit())crop=[bits.readUE(),bits.readUE(),bits.readUE(),bits.readUE()];
    const width=widthMbs*16,height=(2-frameMbsOnly)*heightUnits*16,cropX=chromaFormatIdc===0?1:chromaFormatIdc===3?1:2,cropY=chromaFormatIdc===0?2-frameMbsOnly:chromaFormatIdc===3?2-frameMbsOnly:2*(2-frameMbsOnly);
    return {width:width-(crop[0]+crop[1])*cropX,height:height-(crop[2]+crop[3])*cropY};
  }catch{return {width:0,height:0};}
}
module.exports={parseSpsDimensions};
