用户的验收开发流程
在docs每个loop表示一次开发验收循环，每次我们都用最新的loop来操作 
文件结构 loop-demo 
decision 文件夹
*.decision.md: 决定
plan 文件夹
*.plan.md: 根据决定制定的一轮计划
record 文件夹
*.record.md: 原始的记录用户的记录的问题，或者是问题
out文件夹
*.out.md: 遗留的问题终结这个loop
1. 用添加问题到record.md 中 git commit 
2. Agent 回复逐条处理记录 （答复/调查/编写执行计划）但是严禁修改代码 可以写文档到*.decision.md 下 每处理一个一个commit
3. 用户在处理完一部分的记录后 创建*.plan.md 写出我们如何执行多个decison 的执行 添加commit 
4. 用户要求执行按照*.plan.md执行计划 添加commit
5. 然后我们可以把遗留的问题或者日后规划处理的点放在*.output.md中 添加commit

对于*.decision.md 用户也可以自己记录decision

对于生成的plan
1. 搜索所有的decisions
2. 创建场景用例去包括这些decisions 如果是不同的流程就创建多个
3. 检验是否有冲突的地方如果有等待用户决策
4. 为每个场景生成实施计划，从domain层，service 层，UI层 去考虑（如果改动不涉及就写不涉及），不需要过多的代码细节
文件格式


``` markdown
## senairos
### senairo1
#### include decision 
#### description
#### impl plan
**domain**
**service**
**UI**

### senairo2
### senairo3




```
实施计划时 
每完成一个场景的修改需要提交，并且记录实施的在plan的相关章节里面


## 对于处理用户的记录
处理完每条用户的记录你需要在记录下面评论
如果是调查需要记录调查的结果，如果是直接执行的简单任务写下关联创建的decision以及简要介绍范围