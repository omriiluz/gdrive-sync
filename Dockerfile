FROM dockerimages/nave
ADD gdrive-sync.json /gdrive-sync/package.json
ADD gdrive-sync.js /gdrive-sync/app.js
CMD ["gdrive-sync"]
