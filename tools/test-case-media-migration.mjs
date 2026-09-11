import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const migration=name=>fs.readFileSync(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8');
try {
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create schema storage;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
 alter table storage.objects enable row level security;
 create function storage.foldername(text) returns text[] language sql immutable as $$select (string_to_array($1,'/'))[1:array_length(string_to_array($1,'/'),1)-1]$$;
 grant usage on schema public,auth,storage to anon,authenticated,service_role;
 grant all on storage.objects to authenticated;`);
 // gen_random_uuid is built into this PostgreSQL engine; pgcrypto extension is
 // not packaged in PGlite. The production migration is otherwise executed intact.
 await db.exec(migration('202608210001_cases_backend').replace('create extension if not exists pgcrypto;',''));
 for(const name of ['202608220001_grant_authenticated_case_permissions','202608230001_reviewer_workflow_permissions','202608230002_storage_publish_select_policy','202609030001_case_photo_layouts'])await db.exec(migration(name));
 const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',reviewer='33333333-3333-4333-8333-333333333333';
 await db.exec(`insert into auth.users(id,email) values('${owner}','a@test'),('${other}','b@test'),('${reviewer}','r@test');update profiles set role='reviewer' where id='${reviewer}';
 insert into cases(id,title,created_by,status,consent_confirmed,consent_confirmed_by,consent_confirmed_at)values('legacy','舊案例','${owner}','published',true,'${owner}',now());
 insert into case_photo_pairs(case_id,before_private_path,after_private_path,before_public_path,after_public_path,published_canvas_ratio,published_split_direction)values('legacy','old-before','old-after','public-before','public-after','4:3','horizontal');
 insert into cases(id,title,created_by) values('draft','草稿案例','${owner}');`);
 await db.exec(migration('202609100001_case_mixed_media'));
 const old=(await db.query("select * from case_photo_pairs where case_id='legacy'")).rows[0];
 assert.equal(old.before_public_path,'public-before');assert.equal(old.published_layout_kind,'comparison');assert.equal(old.published_before_media_type,'image');
 await db.exec("insert into case_photo_pairs(case_id,layout_kind)values('draft','single'),('draft','comparison')");
 await assert.rejects(()=>db.exec("insert into case_photo_pairs(case_id,layout_kind,after_private_path)values('draft','single','unexpected')"),/case_media_single_slot_check/);
 await assert.rejects(()=>db.exec("update case_photo_pairs set published_layout_kind='single',before_public_path='video',published_before_media_type='video',published_canvas_ratio='4:3',published_split_direction='horizontal' where case_id='draft' and layout_kind='single'"),/case_media_public_snapshot_check/);
 const asUser=async(user,sql)=>{await db.exec(`reset role;set request.jwt.claim.sub='${user}';set role authenticated;`);return db.query(sql);};
 await asUser(owner,`insert into storage.objects(bucket_id,name)values('case-video-drafts','${owner}/draft/a.mp4')`);
 await assert.rejects(()=>asUser(other,`insert into storage.objects(bucket_id,name)values('case-video-drafts','${other}/draft/b.mp4')`),/row-level security/);
 assert.equal((await asUser(other,"select * from storage.objects")).rows.length,0);
 assert.equal((await asUser(reviewer,"select * from storage.objects")).rows.length,1);
 await assert.rejects(()=>asUser(owner,"insert into storage.objects(bucket_id,name)values('case-video-published','draft/public.mp4')"),/row-level security/);
 await asUser(reviewer,"insert into storage.objects(bucket_id,name)values('case-video-published','draft/public.mp4')");
 await db.exec("reset role;set request.jwt.claim.sub='';set role anon;");
 assert.equal((await db.query('select id,published_layout_kind from case_photo_pairs')).rows.length,1,'only published legacy group visible');
 await assert.rejects(()=>db.query('select before_private_path from case_photo_pairs'),/permission denied/);
 await assert.rejects(()=>db.query('select before_video_meta from case_photo_pairs'),/permission denied/);
 await db.exec('reset role;');
 assert.equal((await db.query("select file_size_limit from storage.buckets where id='case-video-drafts'")).rows[0].file_size_limit,52428800);
 assert.equal((await db.query("select file_size_limit from storage.buckets where id='case-drafts'")).rows[0].file_size_limit,15728640,'existing photo source limit retained');
 console.log('Verified actual SQL migration, legacy preservation, mixed-media constraints, owner/reviewer storage RLS and anonymous field grants.');
}finally{await db.close();}
