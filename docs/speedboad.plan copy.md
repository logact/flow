# speedboat plan v2
This plan is target to develop fast and verify fast, and avoid the Cumbersome automation process and overdesign,In this prototype we need agile turn and we need keep our boat light,remove  all extral thinig but the core proces.

for more detail you can read the @RPD

# overview 
core logic
1. learner estimate the level ,the system generate the test tasks ,and init the level by the user's result of the tasks.
2. learner setup some basic information 
   1. his/her task capacity every day.
3. learner set the goal to achieve ,and set the materials into the goal,system analyze the materials and sepearete into to the knowledge points,and init their fluency score in differnet dimmension according to the user's level and the leanrt words conditions
   1. the goal set the target  fluency score in different dimmension of all the kp in the goals' material
   2. the kp here indentify by word/phase/grammar/other.. + sense
4. system generate the learner tasks according to the specific goals and user's learner's everyday capacity.
5. user answer the task assign by system ,and system jude the res and modify the fluency of the knowledge point in different dimension and modify the study plan (the cold interval between the simailar word and the review time ),and update the user's level 


# implementation plan


## T1 define the model schema that cover the scene

## T2 implement learner level and kp estimate pure function.

## T3 implement material (differnet types ,pdf,markdown,txt) import and analyze to the kp pure function

## I4 integrate p3->p2 
integerate the p3-> p2  the kps analyze out in p3 should init the fluency of the p2s estimator


## T5 implement the task generation and result judge pure function .


## T5.1 AI implementtaion for T5

## T6 task assignment pure function

## T7 task jude pure function

## T8  fluency change after T7's jude pure function

## T9 reivew time change after T7's jude pure function

