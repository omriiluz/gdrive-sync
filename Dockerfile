FROM dockerimages/nave
ADD gsync.json /gdrive-sync/package.json
ADD gsync.js /gdrive-sync/app.js
CMD ["gdrive-sync"]
