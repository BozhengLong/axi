// current和candidate均是v1 auto；old始终是正式基线v0，不能混用名称。
export const versions=[
 {product:'v0',variant:'old',axiEntry:'/opt/axi-v0/src/main.ts'},
 {product:'current',variant:'new',axiEntry:'/opt/axi-current/src/main.ts'},
 {product:'candidate',variant:'new',axiEntry:'/opt/axi/src/main.ts'},
 {product:'claude',variant:'claude',axiEntry:undefined},
] as const;
