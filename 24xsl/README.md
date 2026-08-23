# \# 24.xsl



为虚拟主播 \*\*小松绿Viridis\*\* 设计的 24 点纸牌游戏，UI 参考了人物设定风格。



\---



\## 快速开始



克隆或下载本仓库后，直接双击 `index.html` 即可在浏览器中打开游戏，无需任何网络或后端环境。



\---



\## 游戏规则



本游戏遵循 24 点原教旨规则，仅允许正整数参与运算，不支持负数、分数及根式运算。



\- 使用四张牌，通过 `+`、`-`、`×`、`÷` 四种运算，使最终结果等于 24。

\- 牌面点数：A = 1，J = 11，Q = 12，K = 13。

\- 减法结果必须为正整数。

\- 除法必须在能够整除时执行。

\- 四张牌必须全部使用且仅使用一次。



\---



\## 游戏操作



| 步骤 | 操作 |

|------|------|

| 1 | 点击一张牌，将其选中（高亮） |

| 2 | 点击一个运算符（`+`、`-`、`×`、`÷`） |

| 3 | 点击另一张牌，完成该步计算 |

| 4 | 重复以上步骤，直到所有牌合并为一张 |

| 结果 | 若最终值为 24，本局通关，自动计入分数并进入下一题 |



\---



\## 辅助操作



| 按钮 | 功能 |

|------|------|

| `？` | 判断当前牌组是否存在可行解。若判断正确，直接计分并进入下一题 |

| 重置 | 将当前牌组恢复为本局初始状态，不重新发牌 |

| 答案 | 自动演示完整的解题步骤（高亮显示每一步） |

| 下一题 | 重新随机发牌，开始新一局 |



界面右上角显示已通关的局数。



\---



\## 文件结构

24.xsl/

├── index.html # 游戏主页面

├── style.css # 样式表（桌面/移动端自适应）

├── game.js # 游戏逻辑、求解算法与演示控制

├── assets/

│ ├── fonts/ # Noto Sans SC 中文字体

│ │ ├── NotoSansSC-Regular.ttf

│ │ └── NotoSansSC-Bold.ttf

│ ├── card-1.png # 四张卡牌底图

│ ├── card-2.png

│ ├── card-3.png

│ ├── card-4.png

│ ├── operator-plus.png

│ ├── operator-minus.png

│ ├── operator-multiply.png

│ ├── operator-divide.png

│ ├── no-solution.png

│ ├── nav-next.png

│ ├── nav-reset.png

│ ├── nav-answer.png

│ ├── page-background.webp

│ ├── stage-desktop.png

│ ├── stage-mobile.png

│ └── title-plaque.webp

└── README.md





\---



\## 技术栈



\- HTML5 + CSS3 + JavaScript (ES6+)

\- 无外部库或框架，所有资源本地加载

\- 字体通过 `@font-face` 自托管

\- 响应式设计：容器查询 + 媒体适配

\- 动画：Web Animations API + CSS Keyframes



