gdrive-sync
===========

Sync local files to Google Drive using Node.JS. Fast and portable.

---------------------------------------------------
  Usage: gsync [options] [command]

  Commands:

    sync [options] <src> <target>
       Sync to gdrive

    list [options] <src> <target>
       list pending changes only

    authorize
       authorize access to your google drive

    test
       test


  Options:

    -h, --help     output usage information
    -V, --version  output the version number

-----------------------------------------------------
  Usage: gsync sync [options] src target

  Options:

    -h, --help                     output usage information
    -D, --diff-file <csv_file>     Write CSV diff file to <csv_file>
    -L, --limit-changes <percent>  Allow sync of changes up to <percent> of files, 1% by default
    -R, --reparent <location>      Reparent files to be deleted to this location on your google drive

-----------------------------------------------------
  Usage: gsync list [options] src target

  Options:

    -h, --help                  output usage information
    -D, --diff-file <csv_file>  Write CSV diff file to <csv_file>
