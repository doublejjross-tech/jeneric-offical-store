require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const app = express();
const isProd = process.env.NODE_ENV === 'production';
if(isProd) app.set('trust proxy', 1);
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'20kb'}));
app.use(session({name:'jeneric.sid',secret:process.env.SESSION_SECRET || (isProd ? (()=>{throw new Error('SESSION_SECRET required')})() : 'dev-only-not-secure'),resave:false,saveUninitialized:false,cookie:{httpOnly:true,secure:isProd,sameSite:'lax',maxAge:86400000}}));
app.use(express.static('public'));
const client = new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]});
let botReady = false;
if(process.env.DISCORD_BOT_TOKEN){client.login(process.env.DISCORD_BOT_TOKEN).then(()=>{botReady=true;console.log('Discord bot ready')}).catch(e=>console.error('Bot login failed:',e.message));}
const products = {basic:'JENERIC Basic Tweak Pack — $30',advanced:'JENERIC Advanced Tweak Pack — $45',checkup:'JENERIC PC Checkup'};
const origin = ()=>(process.env.PUBLIC_URL||'http://localhost:3000').replace(/\/$/,'');
const redirectUri = ()=>origin()+'/auth/callback';
const readyOAuth=()=>Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
app.get('/api/status',(req,res)=>res.json({discordConfigured:readyOAuth()&&botReady&&!!process.env.DISCORD_GUILD_ID,authenticated:!!req.session.user,user:req.session.user?{id:req.session.user.id,username:req.session.user.username}:null}));
app.get('/auth/discord',(req,res)=>{if(!readyOAuth())return res.status(503).send('Discord OAuth not configured.'); const state=crypto.randomBytes(24).toString('hex');req.session.oauthState=state;const url=new URL('https://discord.com/oauth2/authorize');url.search=new URLSearchParams({client_id:process.env.DISCORD_CLIENT_ID,response_type:'code',redirect_uri:redirectUri(),scope:'identify',state}).toString();res.redirect(url.toString());});
app.get('/auth/callback',async(req,res)=>{if(!req.query.state||req.query.state!==req.session.oauthState||typeof req.query.code!=='string')return res.status(400).send('Invalid OAuth state');delete req.session.oauthState;try{const params=new URLSearchParams({client_id:process.env.DISCORD_CLIENT_ID,client_secret:process.env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code:req.query.code,redirect_uri:redirectUri()});const tokenResp=await fetch('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:params});if(!tokenResp.ok)throw Error('OAuth token exchange failed');const tokens=await tokenResp.json();const userResp=await fetch('https://discord.com/api/users/@me',{headers:{Authorization:'Bearer '+tokens.access_token}});if(!userResp.ok)throw Error('Discord profile unavailable');const user=await userResp.json();req.session.regenerate(err=>{if(err)return res.status(500).send('Session error');req.session.user={id:user.id,username:user.username};req.session.save(()=>res.redirect('/#request'));});}catch(e){console.error(e.message);res.status(502).send('Discord sign-in failed. Check configuration.');}});
app.post('/auth/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));
const ticketLimit=rateLimit({windowMs:60*60*1000,limit:3,standardHeaders:'draft-7',legacyHeaders:false,message:{error:'Ticket limit reached. Try again later.'}});
app.post('/api/tickets',ticketLimit,async(req,res)=>{
 if(!req.session.user)return res.status(401).json({error:'Sign in with Discord first.'});
 if(!botReady||!process.env.DISCORD_GUILD_ID)return res.status(503).json({error:'Discord ticket system is not configured yet.'});
 const {selected,notes}=req.body||{};
 if(!Array.isArray(selected)||selected.length<1||selected.length>1||selected.some(x=>typeof x!=='string'||!products[x])||new Set(selected).size!==selected.length)return res.status(400).json({error:'Select valid services.'});
 if(typeof notes!=='string'||notes.length>1500)return res.status(400).json({error:'Invalid or oversized details.'});
 try{
  const guild=await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
  const staffRole=process.env.DISCORD_STAFF_ROLE_ID?await guild.roles.fetch(process.env.DISCORD_STAFF_ROLE_ID):null;
  const botMember=await guild.members.fetchMe();
  if(!botMember.permissions.has(PermissionFlagsBits.ManageChannels))return res.status(503).json({error:'Bot needs Manage Channels permission.'});
  const user=req.session.user;
  const existing=guild.channels.cache.find(ch=>ch.type===ChannelType.GuildText&&ch.topic===`jeneric-ticket-user:${user.id}`);
  if(existing)return res.status(409).json({error:'You already have an open ticket.',channelId:existing.id});
  const safe=(v)=>v.replace(/@/g,'＠').replace(/`/g,"'").replace(/[<>]/g,'');
  const suffix=crypto.randomBytes(3).toString('hex');
  const overrides=[{id:guild.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel]},{id:client.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ManageChannels]}];
  // Customers must join the server before opening a ticket so they can answer the bot.
  try{await guild.members.fetch(user.id);}catch{return res.status(400).json({error:'Join the JENERIC Discord server before opening a ticket.'});}
  overrides.push({id:user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]});
  if(staffRole)overrides.push({id:staffRole.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]});
  const options={name:`ticket-${user.username.toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,15)||'customer'}-${suffix}`,type:ChannelType.GuildText,topic:`jeneric-ticket-user:${user.id}`,permissionOverwrites:overrides,reason:'JENERIC website support request'};
  if(process.env.DISCORD_TICKET_CATEGORY_ID)options.parent=process.env.DISCORD_TICKET_CATEGORY_ID;
  const channel=await guild.channels.create(options);
  const embed=new EmbedBuilder().setColor(0xd62638).setTitle('New JENERIC Store Request').addFields({name:'Customer',value:safe(user.username)+' (`'+user.id+'`)'},{name:'Services',value:selected.map(id=>'• '+products[id]).join('\n')},{name:'Additional requests',value:safe(notes.trim()||'None')}).setTimestamp();
  await channel.send({content:`${staffRole?`<@&${staffRole.id}> `:''}New ticket from <@${user.id}>`,embeds:[embed],allowedMentions:{roles:staffRole?[staffRole.id]:[],users:[user.id]}});
  // The bot asks for hardware details *inside Discord*, one question at a time.
  // Message collectors require GuildMessages and MessageContent gateway intents.
  void (async()=>{
    const questions=[['CPU','What is your **CPU** model?'],['GPU','What is your **GPU** model?'],['RAM type','What is your **RAM type** (DDR3, DDR4, DDR5, etc.)?'],['RAM amount','How much **RAM** do you have (for example, 16 GB)?'],['RAM speed','What is your **RAM speed** (for example, 3200 MHz)?'],['Motherboard','What is your **motherboard** model?'],['Main game','What is your **main game**?']];
    const answers=[];
    try{
      await channel.send({content:`<@${user.id}> Welcome! I'll collect your PC details. Reply to each question in this channel. Type **skip** if you don't know.`,allowedMentions:{users:[user.id]}});
      for(const [label,question] of questions){
        await channel.send(question);
        const replies=await channel.awaitMessages({filter:m=>m.author.id===user.id&&!m.author.bot,max:1,time:10*60*1000,errors:['time']});
        const answer=replies.first().content.trim().slice(0,250);
        answers.push({name:label,value:safe(answer||'Not provided')});
      }
      await channel.send({embeds:[new EmbedBuilder().setColor(0x28a66a).setTitle('Customer PC Specifications').addFields(answers).setFooter({text:'Hardware questionnaire completed'})]});
      await channel.send('Thank you! The JENERIC team can now review your request.');
    }catch{
      await channel.send({content:'The hardware questionnaire timed out. Please ask staff to restart the intake if you still need assistance.'}).catch(()=>{});
    }
  })();
  res.status(201).json({ok:true,channelId:channel.id,url:`https://discord.com/channels/${guild.id}/${channel.id}`});
 }catch(e){console.error('Ticket creation failed:',e.message);res.status(500).json({error:'Could not create ticket. Check Discord bot permissions and settings.'});}
});
app.listen(process.env.PORT||3000,()=>console.log('JENERIC store listening'));
