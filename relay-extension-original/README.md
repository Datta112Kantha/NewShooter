
--3.3.3[**NEW**]
--added Phone verification system by sms222.us
-- refactored login system default delay of 8 seconds/ smtp


--3.3.2[**NEW**]
[yahoo relay]
-- added retry mechanism of email upto 3 times per email if it fails
-- fix some bug on interfering popups
-- fixed content where only html is supported [ now support plain text and html]
-- added observer to clear to interrupting popup during shoot


--3.3.1 
-- added outlook relay
-- added variable time setting for outlook
-- added diffent color rows for each smtp
-- single shoot for every relay is intergrated in extension
-- once converted to single it will be disconnected from server
-- UI/UX enhancement

[bug]

-- In yahoo relay please use proper html formatting

exmaple 

Hii - > this is incorrect as it not enclose in poper html 

instead use :

<p> Hii </p> -> this is correct 



-- 3.2.3 [**NEW**]

- added support for other region of yahoo mails
- fixed some bug on oldLayout
-- added duration/ email for yahoo mails.


[To fix]

-- multiple instance of yahoo_srv_page is loaded into the page
-- when any error occur in yahoo it shouldnt stop ue try and catch in process email


-- implement authentication from outlook.srv.js to gmail and yahoo
-- implement single relay into multiple for all server.





--3.2.2[**NEW**]

-- added support for yahoo old layout mail
-- now panel show yahoo smtps in purple color
-- added option to pin email in relay panel
-- enhanced UI/UX 


--3.2.1 [**NEW**]
- Faster Shooting Speed 
-- Auto zoom out until inbox and draft is visible




--- 3.2.0 

 [ Addedd ] - Yahoo Relay [Expect Bugs]

[Usage]
- update extension to version 3.2.0
- login email and relay will run automaticall
- zoomout the page as possible so that side bar shows the draft and Inbox number 
- AlWAYS USE HTML CONTENT , NO PLAIN TEXT OTHERWISE IT WONT WORK.



[ Bugs]

- When being refreshed sometime the UI doesnt open , need manual intervention
close the tab and open the mail in a new tab [no need to login again]


[Yahoo Relay Debug]
- Missing Subject , data or emails is being skipped increase shoot timer from panel

[Missing Feature]
-- It doesnt detect when smtp is limit reached



-Too Do 

Simplify postMessage to send to speicif script

